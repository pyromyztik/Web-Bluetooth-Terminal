/**
 * Thermal Scaler and Reconstruction Engine.
 * Direct JavaScript port of the ESP32-S3 camera firmware scaling and denoising pipeline.
 *
 * Implements:
 * 1. 3x3 Peak-Preserving Edge-Preserving Median Denoise (filterPeakPreservingMedian)
 * 2. Temporal Anti-Aliasing Upsampling (TAAU):
 *    - Sub-pixel motion registration (SSD block-matching with parabolic refinement)
 *    - Camera-pan attenuation deadband
 *    - 3x3 low-res neighborhood bounding-box clamping (anti-ghosting)
 *    - Separable 4-tap Catmull-Rom cubic spline evaluation
 *    - Dynamic disocclusion temporal difference rejection
 *    - Contrast-adaptive single-pass unsharp mask sharpening
 * 3. Fallback analytical reconstruction modes:
 *    - Bicubic (Catmull-Rom)
 *    - Lanczos-3 (6-tap sinc-windowed)
 *    - Bilinear
 *    - Nearest Neighbor (LUT integer pixel replication)
 */

/**
 * 3x3 Peak-Preserving Edge-Preserving Median Filter.
 * Eliminates high-frequency noise and checkerboard dither while strictly preserving
 * true isolated thermal hotspots (e.g. SMD components or pinpoint heat sources).
 *
 * @param {Float32Array} src Source temperature grid
 * @param {Float32Array} dst Destination temperature grid
 * @param {number} peakThreshold Temperature delta above median to retain peak (°C)
 * @param {number} width Grid width
 * @param {number} height Grid height
 */
function filterPeakPreservingMedian(src, dst, peakThreshold = 2.0, width = 24, height = 32) {
  const window = new Float32Array(9);

  for (let r = 0; r < height; ++r) {
    const rowOffset = r * width;
    for (let c = 0; c < width; ++c) {
      let count = 0;
      const centerVal = src[rowOffset + c];

      for (let dr = -1; dr <= 1; ++dr) {
        const nr = r + dr;
        if (nr < 0 || nr >= height) continue;
        const nOffset = nr * width;

        for (let dc = -1; dc <= 1; ++dc) {
          const nc = c + dc;
          if (nc < 0 || nc >= width) continue;
          window[count++] = src[nOffset + nc];
        }
      }

      // Sort small 9-element neighborhood for exact median
      const sub = window.subarray(0, count);
      sub.sort();
      const medianVal = sub[Math.floor(count / 2)];

      const diff = centerVal - medianVal;
      if (diff > peakThreshold) {
        // Genuine isolated hotspot: preserve true peak temperature
        dst[rowOffset + c] = centerVal;
      } else {
        // Sensor noise / checkerboard dither / uniform area: exact median
        dst[rowOffset + c] = medianVal;
      }
    }
  }
}

/**
 * Sinc window function for Lanczos kernel.
 * @param {number} x
 * @return {number}
 */
function sinc(x) {
  if (Math.abs(x) < 1e-5) return 1.0;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

/**
 * Lanczos-3 weight function (6 taps: [-3, 3]).
 * @param {number} x
 * @return {number}
 */
function lanczos3Weight(x) {
  const ax = Math.abs(x);
  if (ax >= 3.0) return 0.0;
  return sinc(x) * sinc(x / 3.0);
}

/**
 * High-performance thermal image upscaling and temporal reconstruction engine.
 */
class ThermalScaler {
  constructor() {
    this.vpW = 0;
    this.vpH = 0;
    this.gridW = 0;
    this.gridH = 0;

    // Ping-pong history buffers for TAAU
    this.histA = null;
    this.histB = null;
    this.histRead = null;
    this.histWrite = null;
    this.historyValid = false;

    // Previous low-res frame for motion estimation
    this.prevLow = null;

    // Intermediate horizontal row cache for separable bicubic/lanczos
    this.intermediateRows = null;

    // Low-resolution 3x3 bounding-box buffers for anti-ghosting
    this.lowMin = null;
    this.lowMax = null;

    // Precomputed 1D interpolation tables
    this.colNNTable = null;
    this.rowNNTable = null;
    this.colBilinearTable = null;
    this.rowBilinearTable = null;
    this.colCubicTable = null;
    this.rowCubicTable = null;
    this.colLanczosTable = null;
    this.rowLanczosTable = null;

    // Fast 3-line SRAM buffer for single-pass unsharp sharpening
    this.lineBuf = null;

    // Intermediate bounding-box row caches
    this.interMin0 = null;
    this.interMin1 = null;
    this.interMax0 = null;
    this.interMax1 = null;
    this.cachedMinY0 = -1;
    this.cachedMinY1 = -1;
  }

  /**
   * Resets temporal history (e.g. on rotation or scaling mode switch).
   */
  reset() {
    this.historyValid = false;
    if (this.prevLow) {
      this.prevLow.fill(0);
    }
  }

  /**
   * Reconfigures viewport dimensions and precomputes interpolation coefficients.
   * @param {number} vpW Viewport width in display pixels
   * @param {number} vpH Viewport height in display pixels
   * @param {number} gridW Source sensor width
   * @param {number} gridH Source sensor height
   */
  reconfigureViewport(vpW, vpH, gridW, gridH) {
    if (this.vpW === vpW && this.vpH === vpH && this.gridW === gridW && this.gridH === gridH) {
      return;
    }

    this.vpW = vpW;
    this.vpH = vpH;
    this.gridW = gridW;
    this.gridH = gridH;
    this.cachedMinY0 = -1;
    this.cachedMinY1 = -1;

    const totalHighPixels = vpW * vpH;
    const totalLowPixels = gridW * gridH;

    // Allocate / resize history buffers
    this.histA = new Float32Array(totalHighPixels);
    this.histB = new Float32Array(totalHighPixels);
    this.histRead = this.histA;
    this.histWrite = this.histB;
    this.historyValid = false;

    this.prevLow = new Float32Array(totalLowPixels);
    this.intermediateRows = new Float32Array(gridH * vpW);
    this.lowMin = new Float32Array(totalLowPixels);
    this.lowMax = new Float32Array(totalLowPixels);

    this.interMin0 = new Float32Array(vpW);
    this.interMin1 = new Float32Array(vpW);
    this.interMax0 = new Float32Array(vpW);
    this.interMax1 = new Float32Array(vpW);

    this.lineBuf = [
      new Float32Array(vpW),
      new Float32Array(vpW),
      new Float32Array(vpW),
    ];

    // 0. Precompute Nearest-Neighbor tables
    this.colNNTable = new Uint8Array(vpW);
    for (let x = 0; x < vpW; ++x) {
      let gx = Math.floor(x * gridW / vpW);
      if (gx < 0) gx = 0;
      if (gx > gridW - 1) gx = gridW - 1;
      this.colNNTable[x] = gx;
    }

    this.rowNNTable = new Uint8Array(vpH);
    for (let y = 0; y < vpH; ++y) {
      let gy = Math.floor(y * gridH / vpH);
      if (gy < 0) gy = 0;
      if (gy > gridH - 1) gy = gridH - 1;
      this.rowNNTable[y] = gy;
    }

    // 1. Precompute Bilinear tables
    this.colBilinearTable = new Array(vpW);
    for (let x = 0; x < vpW; ++x) {
      const u = x * (gridW - 1) / (vpW - 1);
      const x0 = Math.floor(u);
      const x1 = (x0 < gridW - 1) ? (x0 + 1) : (gridW - 1);
      this.colBilinearTable[x] = {x0, x1, fx: u - x0};
    }

    this.rowBilinearTable = new Array(vpH);
    for (let y = 0; y < vpH; ++y) {
      const v = y * (gridH - 1) / (vpH - 1);
      const y0 = Math.floor(v);
      const y1 = (y0 < gridH - 1) ? (y0 + 1) : (gridH - 1);
      this.rowBilinearTable[y] = {y0, y1, fy: v - y0};
    }

    // 2. Precompute 1D Catmull-Rom Cubic Spline tables
    this.colCubicTable = new Array(vpW);
    for (let x = 0; x < vpW; ++x) {
      const u = x * (gridW - 1) / (vpW - 1);
      let x1 = Math.floor(u);
      if (x1 > gridW - 1) x1 = gridW - 1;
      const t = u - x1;

      const x0 = (x1 > 0) ? (x1 - 1) : 0;
      const x2 = (x1 < gridW - 1) ? (x1 + 1) : (gridW - 1);
      const x3 = (x2 < gridW - 1) ? (x2 + 1) : (gridW - 1);

      const t2 = t * t;
      const t3 = t2 * t;

      this.colCubicTable[x] = {
        idx0: x0,
        idx1: x1,
        idx2: x2,
        idx3: x3,
        w0: -0.5 * t3 + 1.0 * t2 - 0.5 * t,
        w1: 1.5 * t3 - 2.5 * t2 + 1.0,
        w2: -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        w3: 0.5 * t3 - 0.5 * t2,
      };
    }

    this.rowCubicTable = new Array(vpH);
    for (let y = 0; y < vpH; ++y) {
      const v = y * (gridH - 1) / (vpH - 1);
      let y1 = Math.floor(v);
      if (y1 > gridH - 1) y1 = gridH - 1;
      const t = v - y1;

      const y0 = (y1 > 0) ? (y1 - 1) : 0;
      const y2 = (y1 < gridH - 1) ? (y1 + 1) : (gridH - 1);
      const y3 = (y2 < gridH - 1) ? (y2 + 1) : (gridH - 1);

      const t2 = t * t;
      const t3 = t2 * t;

      this.rowCubicTable[y] = {
        idx0: y0,
        idx1: y1,
        idx2: y2,
        idx3: y3,
        w0: -0.5 * t3 + 1.0 * t2 - 0.5 * t,
        w1: 1.5 * t3 - 2.5 * t2 + 1.0,
        w2: -1.5 * t3 + 2.0 * t2 + 0.5 * t,
        w3: 0.5 * t3 - 0.5 * t2,
      };
    }

    // 3. Precompute 1D Lanczos-3 tables (6 taps)
    this.colLanczosTable = new Array(vpW);
    for (let x = 0; x < vpW; ++x) {
      const u = x * (gridW - 1) / (vpW - 1);
      const xc = Math.floor(u);
      let sumW = 0.0;
      const entry = {idx: new Int32Array(6), w: new Float32Array(6)};

      for (let k = -2; k <= 3; ++k) {
        const tapIdx = k + 2;
        let srcIdx = xc + k;
        if (srcIdx < 0) srcIdx = 0;
        else if (srcIdx > gridW - 1) srcIdx = gridW - 1;

        const dist = u - (xc + k);
        const weight = lanczos3Weight(dist);
        entry.idx[tapIdx] = srcIdx;
        entry.w[tapIdx] = weight;
        sumW += weight;
      }
      if (Math.abs(sumW) > 1e-5) {
        for (let k = 0; k < 6; ++k) {
          entry.w[k] /= sumW;
        }
      }
      this.colLanczosTable[x] = entry;
    }

    this.rowLanczosTable = new Array(vpH);
    for (let y = 0; y < vpH; ++y) {
      const v = y * (gridH - 1) / (vpH - 1);
      const yc = Math.floor(v);
      let sumW = 0.0;
      const entry = {idx: new Int32Array(6), w: new Float32Array(6)};

      for (let k = -2; k <= 3; ++k) {
        const tapIdx = k + 2;
        let srcIdx = yc + k;
        if (srcIdx < 0) srcIdx = 0;
        else if (srcIdx > gridH - 1) srcIdx = gridH - 1;

        const dist = v - (yc + k);
        const weight = lanczos3Weight(dist);
        entry.idx[tapIdx] = srcIdx;
        entry.w[tapIdx] = weight;
        sumW += weight;
      }
      if (Math.abs(sumW) > 1e-5) {
        for (let k = 0; k < 6; ++k) {
          entry.w[k] /= sumW;
        }
      }
      this.rowLanczosTable[y] = entry;
    }
  }

  /**
   * Computes 3x3 low-res neighborhood min and max for TAAU anti-ghosting clamping.
   * @param {Float32Array} lowGrid
   * @param {number} w
   * @param {number} h
   * @param {Float32Array} outMin
   * @param {Float32Array} outMax
   */
  computeNeighborhoodMinMax(lowGrid, w, h, outMin, outMax) {
    for (let y = 0; y < h; ++y) {
      const yStart = (y > 0) ? (y - 1) : 0;
      const yEnd = (y < h - 1) ? (y + 1) : (h - 1);

      for (let x = 0; x < w; ++x) {
        const xStart = (x > 0) ? (x - 1) : 0;
        const xEnd = (x < w - 1) ? (x + 1) : (w - 1);

        let localMin = lowGrid[y * w + x];
        let localMax = localMin;

        for (let ny = yStart; ny <= yEnd; ++ny) {
          const rowOff = ny * w;
          for (let nx = xStart; nx <= xEnd; ++nx) {
            const val = lowGrid[rowOff + nx];
            if (val < localMin) localMin = val;
            if (val > localMax) localMax = val;
          }
        }
        const idx = y * w + x;
        outMin[idx] = localMin;
        outMax[idx] = localMax;
      }
    }
  }

  /**
   * Sub-pixel motion registration using SSD block-matching and parabolic interpolation.
   * @param {Float32Array} curLow
   * @param {Float32Array} prevLow
   * @param {number} w
   * @param {number} h
   * @return {{dx: number, dy: number}}
   */
  estimateMotion(curLow, prevLow, w, h) {
    const ssd = [
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0],
    ];
    let minSSD = 1e30;
    let bestU = 2;
    let bestV = 2;

    const margin = 2;
    for (let vIdx = 0; vIdx < 5; ++vIdx) {
      const v = vIdx - 2;
      for (let uIdx = 0; uIdx < 5; ++uIdx) {
        const u = uIdx - 2;

        let curSSD = 0.0;
        for (let y = margin; y < h - margin; ++y) {
          const curRow = y * w;
          const prevRow = (y + v) * w + u;

          for (let x = margin; x < w - margin; ++x) {
            const diff = curLow[curRow + x] - prevLow[prevRow + x];
            curSSD += diff * diff;
          }
        }

        ssd[vIdx][uIdx] = curSSD;
        if (curSSD < minSSD) {
          minSSD = curSSD;
          bestU = uIdx;
          bestV = vIdx;
        }
      }
    }

    let deltaU = 0.0;
    if (bestU > 0 && bestU < 4) {
      const eLeft = ssd[bestV][bestU - 1];
      const eMid = ssd[bestV][bestU];
      const eRight = ssd[bestV][bestU + 1];
      const denomX = 2.0 * (eLeft - 2.0 * eMid + eRight);
      if (denomX > 1e-4) {
        deltaU = (eLeft - eRight) / denomX;
        if (deltaU < -0.5) deltaU = -0.5;
        else if (deltaU > 0.5) deltaU = 0.5;
      }
    }

    let deltaV = 0.0;
    if (bestV > 0 && bestV < 4) {
      const eTop = ssd[bestV - 1][bestU];
      const eMid = ssd[bestV][bestU];
      const eBot = ssd[bestV + 1][bestU];
      const denomY = 2.0 * (eTop - 2.0 * eMid + eBot);
      if (denomY > 1e-4) {
        deltaV = (eTop - eBot) / denomY;
        if (deltaV < -0.5) deltaV = -0.5;
        else if (deltaV > 0.5) deltaV = 0.5;
      }
    }

    let dx = (bestU - 2) + deltaU;
    let dy = (bestV - 2) + deltaV;

    if (dx < -3.0) dx = -3.0;
    else if (dx > 3.0) dx = 3.0;

    if (dy < -3.0) dy = -3.0;
    else if (dy > 3.0) dy = 3.0;

    return {dx, dy};
  }

  /**
   * Renders high-res frame using Temporal Anti-Aliasing Upsampling (TAAU).
   */
  renderTAAU(
      lowGrid,
      outImgData,
      smoothedMin,
      invRange,
      paletteLut,
      alpha = 0.80,
      sharpness = 0.35,
  ) {
    const vpW = this.vpW;
    const vpH = this.vpH;
    const gridW = this.gridW;
    const gridH = this.gridH;
    const totalLow = gridW * gridH;

    // 0. Input sanitization
    const cleanGrid = new Float32Array(totalLow);
    for (let i = 0; i < totalLow; ++i) {
      const v = lowGrid[i];
      cleanGrid[i] = (Number.isFinite(v) && v > -50.0 && v < 400.0) ? v : 25.0;
    }

    // 1. Sub-pixel Motion Registration
    let dx = 0.0;
    let dy = 0.0;
    if (this.historyValid) {
      const motion = this.estimateMotion(cleanGrid, this.prevLow, gridW, gridH);
      dx = motion.dx;
      dy = motion.dy;
    }

    const scaleX = (vpW - 1) / (gridW - 1);
    const scaleY = (vpH - 1) / (gridH - 1);
    const dxHigh = dx * scaleX;
    const dyHigh = dy * scaleY;
    const shiftX = Math.round(dxHigh);
    const shiftY = Math.round(dyHigh);

    // Camera-pan attenuation deadband
    const motionDist = Math.sqrt(dx * dx + dy * dy);
    let panFactor = (motionDist <= 0.50) ? 1.0 : (1.0 - (motionDist - 0.50) * 0.67);
    if (panFactor < 0.0) panFactor = 0.0;
    const baseAlpha = alpha * panFactor;

    // 2. Anti-ghosting 3x3 bounding-box
    this.computeNeighborhoodMinMax(cleanGrid, gridW, gridH, this.lowMin, this.lowMax);

    // 3. Separable Bicubic Horizontal Pass
    for (let r = 0; r < gridH; ++r) {
      const srcOffset = r * gridW;
      const dstOffset = r * vpW;

      for (let x = 0; x < vpW; ++x) {
        const c = this.colCubicTable[x];
        this.intermediateRows[dstOffset + x] =
          c.w0 * cleanGrid[srcOffset + c.idx0] +
          c.w1 * cleanGrid[srcOffset + c.idx1] +
          c.w2 * cleanGrid[srcOffset + c.idx2] +
          c.w3 * cleanGrid[srcOffset + c.idx3];
      }
    }

    this.cachedMinY0 = -1;
    this.cachedMinY1 = -1;

    // 4. Single-pass streaming: Accumulate line Y and sharpen line Y - 1
    const outData32 = new Uint32Array(outImgData.data.buffer);
    const sharpGain = sharpness * 1.5;

    const sharpenAndOutputRow = (rowIdx) => {
      if (rowIdx < 0 || rowIdx >= vpH) return;

      const rowPrev = (rowIdx > 0) ? (rowIdx - 1) : 0;
      const rowNext = (rowIdx < vpH - 1) ? (rowIdx + 1) : (vpH - 1);

      const rCurr = this.lineBuf[rowIdx % 3];
      const rNorth = this.lineBuf[rowPrev % 3];
      const rSouth = this.lineBuf[rowNext % 3];
      const destRowOffset = rowIdx * vpW;

      for (let x = 0; x < vpW; ++x) {
        const xLeft = (x > 0) ? (x - 1) : 0;
        const xRight = (x < vpW - 1) ? (x + 1) : (vpW - 1);

        const C = rCurr[x];
        const N = rNorth[x];
        const S = rSouth[x];
        const W = rCurr[xLeft];
        const E = rCurr[xRight];

        let detail = C - 0.25 * (N + S + W + E);
        if (detail > 2.0) detail = 2.0;
        else if (detail < -2.0) detail = -2.0;

        const tSharp = C + sharpGain * detail;
        let idx = Math.floor((tSharp - smoothedMin) * invRange);
        if (idx < 0) idx = 0;
        else if (idx > 255) idx = 255;

        outData32[destRowOffset + x] = paletteLut[idx];
      }
    };

    for (let y = 0; y < vpH; ++y) {
      const rCubic = this.rowCubicTable[y];
      const ir0 = rCubic.idx0 * vpW;
      const ir1 = rCubic.idx1 * vpW;
      const ir2 = rCubic.idx2 * vpW;
      const ir3 = rCubic.idx3 * vpW;
      const rw0 = rCubic.w0;
      const rw1 = rCubic.w1;
      const rw2 = rCubic.w2;
      const rw3 = rCubic.w3;

      // Update bilinear bounding-box row cache
      const rBilin = this.rowBilinearTable[y];
      if (rBilin.y0 !== this.cachedMinY0 || rBilin.y1 !== this.cachedMinY1) {
        this.cachedMinY0 = rBilin.y0;
        this.cachedMinY1 = rBilin.y1;
        const rawMin0 = rBilin.y0 * gridW;
        const rawMin1 = rBilin.y1 * gridW;
        const rawMax0 = rBilin.y0 * gridW;
        const rawMax1 = rBilin.y1 * gridW;

        for (let x = 0; x < vpW; ++x) {
          const cb = this.colBilinearTable[x];
          const m0a = this.lowMin[rawMin0 + cb.x0];
          const m0b = this.lowMin[rawMin0 + cb.x1];
          const m1a = this.lowMin[rawMin1 + cb.x0];
          const m1b = this.lowMin[rawMin1 + cb.x1];
          const x0a = this.lowMax[rawMax0 + cb.x0];
          const x0b = this.lowMax[rawMax0 + cb.x1];
          const x1a = this.lowMax[rawMax1 + cb.x0];
          const x1b = this.lowMax[rawMax1 + cb.x1];

          this.interMin0[x] = m0a + cb.fx * (m0b - m0a);
          this.interMin1[x] = m1a + cb.fx * (m1b - m1a);
          this.interMax0[x] = x0a + cb.fx * (x0b - x0a);
          this.interMax1[x] = x1a + cb.fx * (x1b - x1a);
        }
      }

      const omfy = 1.0 - rBilin.fy;
      const fy = rBilin.fy;

      let srcY = y - shiftY;
      if (srcY < 0) srcY = 0;
      else if (srcY >= vpH) srcY = vpH - 1;

      const histRowOffset = srcY * vpW;
      const outRowOffset = y * vpW;
      const curLine = this.lineBuf[y % 3];

      for (let x = 0; x < vpW; ++x) {
        const curHigh = rw0 * this.intermediateRows[ir0 + x] +
                        rw1 * this.intermediateRows[ir1 + x] +
                        rw2 * this.intermediateRows[ir2 + x] +
                        rw3 * this.intermediateRows[ir3 + x];

        if (!this.historyValid) {
          this.histWrite[outRowOffset + x] = curHigh;
          curLine[x] = curHigh;
          continue;
        }

        let srcX = x - shiftX;
        if (srcX < 0) srcX = 0;
        else if (srcX >= vpW) srcX = vpW - 1;

        let hVal = this.histRead[histRowOffset + srcX];

        const highMin = omfy * this.interMin0[x] + fy * this.interMin1[x] - 0.15;
        const highMax = omfy * this.interMax0[x] + fy * this.interMax1[x] + 0.15;

        if (hVal < highMin) hVal = highMin;
        else if (hVal > highMax) hVal = highMax;

        // Dynamic Disocclusion / Temporal Difference Rejection (Anti-Ghosting)
        const diff = Math.abs(curHigh - hVal);
        let disocclusionWeight = 1.0 - (diff - 1.00) * 0.50;
        if (disocclusionWeight < 0.0) disocclusionWeight = 0.0;
        else if (disocclusionWeight > 1.0) disocclusionWeight = 1.0;

        const effAlpha = baseAlpha * disocclusionWeight;
        const accum = (1.0 - effAlpha) * curHigh + effAlpha * hVal;

        this.histWrite[outRowOffset + x] = accum;
        curLine[x] = accum;
      }

      if (y > 0) {
        sharpenAndOutputRow(y - 1);
      }
    }
    sharpenAndOutputRow(vpH - 1);

    // Swap history buffers
    this.prevLow.set(cleanGrid);
    const tmp = this.histRead;
    this.histRead = this.histWrite;
    this.histWrite = tmp;
    this.historyValid = true;
  }

  /**
   * Renders frame using separable Catmull-Rom Bicubic interpolation.
   */
  renderBicubic(lowGrid, outImgData, smoothedMin, invRange, paletteLut) {
    const vpW = this.vpW;
    const vpH = this.vpH;
    const gridW = this.gridW;
    const gridH = this.gridH;

    for (let r = 0; r < gridH; ++r) {
      const srcOffset = r * gridW;
      const dstOffset = r * vpW;
      for (let x = 0; x < vpW; ++x) {
        const c = this.colCubicTable[x];
        this.intermediateRows[dstOffset + x] =
          c.w0 * lowGrid[srcOffset + c.idx0] +
          c.w1 * lowGrid[srcOffset + c.idx1] +
          c.w2 * lowGrid[srcOffset + c.idx2] +
          c.w3 * lowGrid[srcOffset + c.idx3];
      }
    }

    const outData32 = new Uint32Array(outImgData.data.buffer);
    for (let y = 0; y < vpH; ++y) {
      const rCubic = this.rowCubicTable[y];
      const ir0 = rCubic.idx0 * vpW;
      const ir1 = rCubic.idx1 * vpW;
      const ir2 = rCubic.idx2 * vpW;
      const ir3 = rCubic.idx3 * vpW;
      const rw0 = rCubic.w0;
      const rw1 = rCubic.w1;
      const rw2 = rCubic.w2;
      const rw3 = rCubic.w3;
      const rowOffset = y * vpW;

      for (let x = 0; x < vpW; ++x) {
        const temp = rw0 * this.intermediateRows[ir0 + x] +
                     rw1 * this.intermediateRows[ir1 + x] +
                     rw2 * this.intermediateRows[ir2 + x] +
                     rw3 * this.intermediateRows[ir3 + x];
        let idx = Math.floor((temp - smoothedMin) * invRange);
        if (idx < 0) idx = 0;
        else if (idx > 255) idx = 255;
        outData32[rowOffset + x] = paletteLut[idx];
      }
    }
  }

  /**
   * Renders frame using separable 6-tap Lanczos-3 interpolation.
   */
  renderLanczos(lowGrid, outImgData, smoothedMin, invRange, paletteLut) {
    const vpW = this.vpW;
    const vpH = this.vpH;
    const gridW = this.gridW;
    const gridH = this.gridH;

    for (let r = 0; r < gridH; ++r) {
      const srcOffset = r * gridW;
      const dstOffset = r * vpW;
      for (let x = 0; x < vpW; ++x) {
        const c = this.colLanczosTable[x];
        this.intermediateRows[dstOffset + x] =
          c.w[0] * lowGrid[srcOffset + c.idx[0]] +
          c.w[1] * lowGrid[srcOffset + c.idx[1]] +
          c.w[2] * lowGrid[srcOffset + c.idx[2]] +
          c.w[3] * lowGrid[srcOffset + c.idx[3]] +
          c.w[4] * lowGrid[srcOffset + c.idx[4]] +
          c.w[5] * lowGrid[srcOffset + c.idx[5]];
      }
    }

    const outData32 = new Uint32Array(outImgData.data.buffer);
    for (let y = 0; y < vpH; ++y) {
      const r = this.rowLanczosTable[y];
      const ir0 = r.idx[0] * vpW;
      const ir1 = r.idx[1] * vpW;
      const ir2 = r.idx[2] * vpW;
      const ir3 = r.idx[3] * vpW;
      const ir4 = r.idx[4] * vpW;
      const ir5 = r.idx[5] * vpW;
      const rowOffset = y * vpW;

      for (let x = 0; x < vpW; ++x) {
        const temp = r.w[0] * this.intermediateRows[ir0 + x] +
                     r.w[1] * this.intermediateRows[ir1 + x] +
                     r.w[2] * this.intermediateRows[ir2 + x] +
                     r.w[3] * this.intermediateRows[ir3 + x] +
                     r.w[4] * this.intermediateRows[ir4 + x] +
                     r.w[5] * this.intermediateRows[ir5 + x];
        let idx = Math.floor((temp - smoothedMin) * invRange);
        if (idx < 0) idx = 0;
        else if (idx > 255) idx = 255;
        outData32[rowOffset + x] = paletteLut[idx];
      }
    }
  }

  /**
   * Renders frame using standard Bilinear interpolation.
   */
  renderBilinear(lowGrid, outImgData, smoothedMin, invRange, paletteLut) {
    const vpW = this.vpW;
    const vpH = this.vpH;
    const gridW = this.gridW;
    const outData32 = new Uint32Array(outImgData.data.buffer);

    for (let y = 0; y < vpH; ++y) {
      const rb = this.rowBilinearTable[y];
      const row0 = rb.y0 * gridW;
      const row1 = rb.y1 * gridW;
      const fy = rb.fy;
      const omfy = 1.0 - fy;
      const destOffset = y * vpW;

      for (let x = 0; x < vpW; ++x) {
        const cb = this.colBilinearTable[x];
        const fx = cb.fx;
        const v0 = lowGrid[row0 + cb.x0] + fx * (lowGrid[row0 + cb.x1] - lowGrid[row0 + cb.x0]);
        const v1 = lowGrid[row1 + cb.x0] + fx * (lowGrid[row1 + cb.x1] - lowGrid[row1 + cb.x0]);
        const temp = omfy * v0 + fy * v1;

        let idx = Math.floor((temp - smoothedMin) * invRange);
        if (idx < 0) idx = 0;
        else if (idx > 255) idx = 255;
        outData32[destOffset + x] = paletteLut[idx];
      }
    }
  }

  /**
   * Renders frame using Nearest Neighbor LUT pixel replication.
   */
  renderNearest(lowGrid, outImgData, smoothedMin, invRange, paletteLut) {
    const vpW = this.vpW;
    const vpH = this.vpH;
    const gridW = this.gridW;
    const outData32 = new Uint32Array(outImgData.data.buffer);

    for (let y = 0; y < vpH; ++y) {
      const gy = this.rowNNTable[y];
      const row = gy * gridW;
      const destOffset = y * vpW;

      for (let x = 0; x < vpW; ++x) {
        const gx = this.colNNTable[x];
        const temp = lowGrid[row + gx];

        let idx = Math.floor((temp - smoothedMin) * invRange);
        if (idx < 0) idx = 0;
        else if (idx > 255) idx = 255;
        outData32[destOffset + x] = paletteLut[idx];
      }
    }
  }

  /**
   * Unified render entry point for all scaling modes.
   */
  render(
      mode,
      lowGrid,
      outImgData,
      smoothedMin,
      invRange,
      paletteLut,
      alpha = 0.80,
      sharpness = 0.35,
  ) {
    switch (mode) {
      case 'NEAREST':
        this.renderNearest(lowGrid, outImgData, smoothedMin, invRange, paletteLut);
        break;
      case 'BILINEAR':
        this.renderBilinear(lowGrid, outImgData, smoothedMin, invRange, paletteLut);
        break;
      case 'BICUBIC':
        this.renderBicubic(lowGrid, outImgData, smoothedMin, invRange, paletteLut);
        break;
      case 'LANCZOS':
        this.renderLanczos(lowGrid, outImgData, smoothedMin, invRange, paletteLut);
        break;
      case 'TAAU':
      default:
        this.renderTAAU(lowGrid, outImgData, smoothedMin, invRange, paletteLut, alpha, sharpness);
        break;
    }
  }
}

// Attach globally for browser usage
window.filterPeakPreservingMedian = filterPeakPreservingMedian;
window.ThermalScaler = ThermalScaler;
