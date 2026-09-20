/**
 * Thermal Camera Stream Viewer and BLE NUS Protocol Handler.
 * Supports Thermophase (MLX90640 32x24 sensor) streaming over Bluetooth Low Energy.
 * Implements:
 * - Subpage checkerboard calibration filter
 * - Peak-preserving median cut noise filter
 * - Authentic Ironbow color palette & additional thermal LUTs
 * - Seamless integrated panel renderer with minimal HTML telemetry chips
 * - Self-contained, modular architecture
 */

// BLE UUIDs for Nordic UART Service (NUS)
const NUS_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_UUID = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // Write to ESP32
const NUS_TX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // Notify from ESP32

// Sensor specifications
const THERMAL_RAW_WIDTH = 32;
const THERMAL_RAW_HEIGHT = 24;
const THERMAL_PIXELS = THERMAL_RAW_WIDTH * THERMAL_RAW_HEIGHT; // 768

// Magic headers
// 0x5a, 0xa5, 0x5a, 0xa5 -> 3076 bytes (Float32)
// 0x5a, 0xa5, 0x5a, 0xa6 -> 1540 bytes (Int16 centi-degrees)
const MAGIC_F32 = [0x5a, 0xa5, 0x5a, 0xa5];
const MAGIC_I16 = [0x5a, 0xa5, 0x5a, 0xa6];
const PACKET_LEN_F32 = 4 + THERMAL_PIXELS * 4; // 3076
const PACKET_LEN_I16 = 4 + THERMAL_PIXELS * 2; // 1540

/**
 * Generates an interpolated 256-color palette lookup table.
 * @param {Array<[number, number, number, number]>} colorStops [stop, r, g, b]
 * @return {Uint32Array} 256 32-bit RGBA packed values (little-endian ABGR for canvas ImageData)
 */
function createPaletteLut(colorStops) {
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let lower = colorStops[0];
    let upper = colorStops[colorStops.length - 1];

    for (let s = 0; s < colorStops.length - 1; s++) {
      if (t >= colorStops[s][0] && t <= colorStops[s + 1][0]) {
        lower = colorStops[s];
        upper = colorStops[s + 1];
        break;
      }
    }

    const range = upper[0] - lower[0];
    const factor = range > 0 ? (t - lower[0]) / range : 0;
    const r = Math.round(lower[1] + factor * (upper[1] - lower[1]));
    const g = Math.round(lower[2] + factor * (upper[2] - lower[2]));
    const b = Math.round(lower[3] + factor * (upper[3] - lower[3]));

    // Little-endian packed 0xAABBGGRR
    lut[i] = (255 << 24) | (b << 16) | (g << 8) | r;
  }
  return lut;
}

// Thermal Colormaps
const THERMAL_COLORMAPS = {
  // FLIR Ironbow: authentic thermal gradient
  IRONBOW: {
    name: 'Ironbow',
    lut: createPaletteLut([
      [0.00, 0, 0, 20],
      [0.08, 16, 0, 82],
      [0.18, 48, 0, 134],
      [0.28, 92, 0, 158],
      [0.40, 155, 0, 142],
      [0.52, 200, 18, 82],
      [0.65, 235, 62, 0],
      [0.78, 250, 142, 0],
      [0.88, 255, 210, 24],
      [0.96, 255, 248, 165],
      [1.00, 255, 255, 255],
    ]),
  },
  INFERNO: {
    name: 'Inferno',
    lut: createPaletteLut([
      [0.00, 0, 0, 4],
      [0.15, 30, 12, 60],
      [0.35, 87, 16, 110],
      [0.55, 155, 41, 100],
      [0.75, 221, 100, 44],
      [0.90, 252, 190, 60],
      [1.00, 252, 255, 164],
    ]),
  },
  TURBO: {
    name: 'Turbo',
    lut: createPaletteLut([
      [0.00, 48, 18, 59],
      [0.20, 70, 134, 251],
      [0.40, 27, 229, 181],
      [0.60, 164, 252, 60],
      [0.80, 251, 136, 36],
      [1.00, 122, 4, 3],
    ]),
  },
  JET: {
    name: 'Jet',
    lut: createPaletteLut([
      [0.00, 0, 0, 143],
      [0.15, 0, 0, 255],
      [0.35, 0, 255, 255],
      [0.60, 255, 255, 0],
      [0.85, 255, 0, 0],
      [1.00, 128, 0, 0],
    ]),
  },
  BONE: {
    name: 'Bone (White-Hot)',
    lut: createPaletteLut([
      [0.00, 0, 0, 0],
      [0.35, 80, 80, 105],
      [0.70, 165, 185, 195],
      [1.00, 255, 255, 255],
    ]),
  },
  PLASMA: {
    name: 'Plasma',
    lut: createPaletteLut([
      [0.00, 13, 8, 135],
      [0.25, 106, 0, 168],
      [0.50, 177, 42, 144],
      [0.75, 225, 100, 98],
      [1.00, 240, 249, 33],
    ]),
  },
};
// Note: High-performance image reconstruction and filtering (TAAU, Bicubic, Lanczos, Bilinear, Nearest,
// and 3x3 Peak-Preserving Median Denoise) are modularized into thermal-scaler.js.

/**
 * BLE Stream Receiver for Thermophase Thermal Camera.
 * Handles Nordic UART Service (NUS) notifications, packet reassembly,
 * stream start detection, and text log extraction.
 */
class ThermalCameraClient {
  constructor() {
    this.device = null;
    this.rxChar = null;
    this.txChar = null;
    this.streamBuffer = [];
    this.isConnected = false;
    this.isStreaming = false;

    this.frameCallbacks = [];
    this.textCallbacks = [];
    this.statusCallbacks = [];
    this.streamStartCallbacks = [];

    this._boundNotify = this._handleNotification.bind(this);
    this._boundDisconnect = this._handleDisconnection.bind(this);
  }

  onFrame(cb) {
    this.frameCallbacks.push(cb);
  }

  onText(cb) {
    this.textCallbacks.push(cb);
  }

  onStatus(cb) {
    this.statusCallbacks.push(cb);
  }

  onStreamStart(cb) {
    this.streamStartCallbacks.push(cb);
  }

  _notifyStatus(connected, message = '') {
    this.isConnected = connected;
    if (!connected) {
      this.isStreaming = false;
    }
    for (const cb of this.statusCallbacks) {
      cb(connected, message);
    }
  }

  _notifyText(text) {
    for (const cb of this.textCallbacks) {
      cb(text);
    }
  }

  _notifyFrame(frame) {
    for (const cb of this.frameCallbacks) {
      cb(frame);
    }
  }

  _notifyStreamStart() {
    for (const cb of this.streamStartCallbacks) {
      cb();
    }
  }

  async connect() {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not supported in this browser.');
    }

    this._notifyStatus(false, 'Scanning for Bluetooth device...');

    const device = await navigator.bluetooth.requestDevice({
      filters: [
        {services: [NUS_SERVICE_UUID]},
        {services: [0xFFE0]},
        {namePrefix: 'thermophase'},
        {namePrefix: 'Thermophase'},
      ],
      optionalServices: [NUS_SERVICE_UUID, 0xFFE0],
    });

    this.device = device;
    this.device.addEventListener('gattserverdisconnected', this._boundDisconnect);

    this._notifyStatus(false, `Connecting to ${device.name || 'Device'}...`);
    const server = await device.gatt.connect();

    // Try Nordic UART Service first
    try {
      const service = await server.getPrimaryService(NUS_SERVICE_UUID);
      this.txChar = await service.getCharacteristic(NUS_TX_UUID);
      await this.txChar.startNotifications();
      this.txChar.addEventListener('characteristicvaluechanged', this._boundNotify);
      try {
        this.rxChar = await service.getCharacteristic(NUS_RX_UUID);
      } catch {
        this.rxChar = null;
      }
    } catch {
      // Fall back to 0xFFE0 / 0xFFE1 (standard serial)
      const service = await server.getPrimaryService(0xFFE0);
      const char = await service.getCharacteristic(0xFFE1);
      await char.startNotifications();
      char.addEventListener('characteristicvaluechanged', this._boundNotify);
      this.txChar = char;
      this.rxChar = char;
    }

    this.streamBuffer = [];
    this.isStreaming = false;
    this._notifyStatus(true, `Connected to ${device.name || 'Device'}`);
  }

  disconnect() {
    if (this.txChar) {
      try {
        this.txChar.removeEventListener('characteristicvaluechanged', this._boundNotify);
      } catch {
        // Ignore cleanup errors
      }
      this.txChar = null;
    }
    this.rxChar = null;

    if (this.device) {
      if (typeof this.device.removeEventListener === 'function') {
        this.device.removeEventListener('gattserverdisconnected', this._boundDisconnect);
      }
      if (this.device.gatt && typeof this.device.gatt.disconnect === 'function' && this.device.gatt.connected) {
        this.device.gatt.disconnect();
      }
      this.device = null;
    }

    this.streamBuffer = [];
    this.isStreaming = false;
    this._notifyStatus(false, 'Disconnected');
  }

  async send(command) {
    if (!this.rxChar) {
      throw new Error('Device is not connected for sending commands.');
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(command + '\n');
    for (let i = 0; i < data.length; i += 20) {
      const chunk = data.slice(i, Math.min(i + 20, data.length));
      await this.rxChar.writeValue(chunk);
    }
  }

  _handleDisconnection() {
    this.streamBuffer = [];
    this.isStreaming = false;
    this._notifyStatus(false, 'Device disconnected');
  }

  _handleNotification(event) {
    const dataView = event.target.value;
    const chunk = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);

    // 1. Filter out text / telemetry messages so they never corrupt the binary stream buffer
    if (chunk.length > 0) {
      let firstCharIdx = 0;
      while (firstCharIdx < chunk.length && (chunk[firstCharIdx] === 0x20 || chunk[firstCharIdx] === 0x09)) {
        firstCharIdx++;
      }
      if (firstCharIdx < chunk.length && chunk[firstCharIdx] === 0x5B /* '[' */ &&
          (chunk.length < 256 || chunk.indexOf(0x0A) !== -1)) {
        try {
          const text = new TextDecoder('utf-8', {fatal: false}).decode(chunk).trim();
          if (text) {
            const lines = text.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                this._notifyText(trimmed);
              }
            }
            return;
          }
        } catch {
          // Fall through to binary stream buffer
        }
      }
    }

    // Also handle general text when not streaming or when line breaks exist without binary headers
    if (this.streamBuffer.length === 0 &&
        !(chunk.length >= 4 &&
          ((chunk[0] === MAGIC_F32[0] && chunk[1] === MAGIC_F32[1]) ||
           (chunk[0] === MAGIC_I16[0] && chunk[1] === MAGIC_I16[1])))) {
      try {
        const text = new TextDecoder('utf-8', {fatal: true}).decode(chunk);
        if (text.includes('\n') || text.includes('\r')) {
          const lines = text.split(/[\r\n]+/);
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              this._notifyText(trimmed);
            }
          }
          return;
        }
      } catch {
        // Binary data throws on fatal utf-8 decoding -> proceed to stream buffer
      }
    }

    // 2. Append binary bytes to stream buffer
    for (let i = 0; i < chunk.length; i++) {
      this.streamBuffer.push(chunk[i]);
    }

    // Prevent buffer from growing unbounded if disconnected or desynced
    if (this.streamBuffer.length > 16384) {
      this.streamBuffer = this.streamBuffer.slice(-4096);
    }

    // 3. Search buffer for magic headers and assemble complete thermal frames
    this._processStreamBuffer();
  }

  /**
   * Searches buffer for magic headers and emits assembled frames.
   */
  _processStreamBuffer() {
    while (this.streamBuffer.length >= 4) {
      let idxF32 = -1;
      let idxI16 = -1;

      for (let i = 0; i <= this.streamBuffer.length - 4; i++) {
        if (idxF32 === -1 &&
            this.streamBuffer[i] === MAGIC_F32[0] &&
            this.streamBuffer[i + 1] === MAGIC_F32[1] &&
            this.streamBuffer[i + 2] === MAGIC_F32[2] &&
            this.streamBuffer[i + 3] === MAGIC_F32[3]) {
          idxF32 = i;
        }
        if (idxI16 === -1 &&
            this.streamBuffer[i] === MAGIC_I16[0] &&
            this.streamBuffer[i + 1] === MAGIC_I16[1] &&
            this.streamBuffer[i + 2] === MAGIC_I16[2] &&
            this.streamBuffer[i + 3] === MAGIC_I16[3]) {
          idxI16 = i;
        }
        if (idxF32 !== -1 || idxI16 !== -1) break;
      }

      if (idxF32 === -1 && idxI16 === -1) {
        if (this.streamBuffer.length > 3) {
          this.streamBuffer = this.streamBuffer.slice(this.streamBuffer.length - 3);
        }
        break;
      }

      // We found a magic header -> streaming is active!
      if (!this.isStreaming) {
        this.isStreaming = true;
        this._notifyStreamStart();
      }

      let isI16 = false;
      let idx = 0;
      let pktLen = 0;

      if (idxF32 !== -1 && (idxI16 === -1 || idxF32 < idxI16)) {
        isI16 = false;
        idx = idxF32;
        pktLen = PACKET_LEN_F32;
      } else {
        isI16 = true;
        idx = idxI16;
        pktLen = PACKET_LEN_I16;
      }

      // Discard any garbage before header
      if (idx > 0) {
        this.streamBuffer = this.streamBuffer.slice(idx);
      }

      // Check if a subsequent magic header appears prematurely (indicates packet loss/truncated frame)
      let nextHeaderIdx = -1;
      const searchEnd = Math.min(this.streamBuffer.length - 3, pktLen);
      for (let i = 4; i < searchEnd; i++) {
        if ((this.streamBuffer[i] === MAGIC_F32[0] &&
             this.streamBuffer[i + 1] === MAGIC_F32[1] &&
             this.streamBuffer[i + 2] === MAGIC_F32[2] &&
             this.streamBuffer[i + 3] === MAGIC_F32[3]) ||
            (this.streamBuffer[i] === MAGIC_I16[0] &&
             this.streamBuffer[i + 1] === MAGIC_I16[1] &&
             this.streamBuffer[i + 2] === MAGIC_I16[2] &&
             this.streamBuffer[i + 3] === MAGIC_I16[3])) {
          nextHeaderIdx = i;
          break;
        }
      }

      if (nextHeaderIdx !== -1) {
        // Discard truncated frame and resync immediately to next header
        this.streamBuffer = this.streamBuffer.slice(nextHeaderIdx);
        continue;
      }

      // Check if full packet has arrived
      if (this.streamBuffer.length < pktLen) {
        break;
      }

      // Extract payload
      const packetBytes = new Uint8Array(this.streamBuffer.slice(4, pktLen));
      this.streamBuffer = this.streamBuffer.slice(pktLen);

      try {
        let frameData = null;
        if (isI16) {
          const int16View = new Int16Array(packetBytes.buffer, packetBytes.byteOffset, THERMAL_PIXELS);
          frameData = new Float32Array(THERMAL_PIXELS);
          for (let p = 0; p < THERMAL_PIXELS; p++) {
            frameData[p] = int16View[p] / 100.0;
          }
        } else {
          frameData = new Float32Array(packetBytes.buffer, packetBytes.byteOffset, THERMAL_PIXELS);
        }

        let isFinite = true;
        let fMin = Infinity;
        let fMax = -Infinity;

        for (let p = 0; p < THERMAL_PIXELS; p++) {
          const val = frameData[p];
          if (!Number.isFinite(val)) {
            isFinite = false;
            break;
          }
          if (val < fMin) fMin = val;
          if (val > fMax) fMax = val;
        }

        // Glitch rejection filter: Physical temperatures must be within reasonable thermal range
        if (isFinite && fMin >= -40.0 && fMax <= 350.0) {
          this._notifyFrame(frameData);
        }
      } catch (err) {
        this._notifyText(`[Decode Error] ${err.message}`);
      }
    }
  }

  /**
   * Ingests external chunks.
   * @param {Uint8Array} chunk Raw BLE byte chunk
   */
  ingestChunk(chunk) {
    this._handleNotification({
      target: {
        value: {
          buffer: chunk.buffer,
          byteOffset: chunk.byteOffset,
          byteLength: chunk.byteLength,
        },
      },
    });
  }
}

/**
 * Thermal Camera Integrated Stream Panel UI Controller and Canvas Renderer.
 */
class ThermalStreamWindow {
  constructor(options = {}) {
    this.options = Object.assign({
      onLog: null,
      onStreamToggleVisibility: null,
      onClose: null,
    }, options);

    this.client = new ThermalCameraClient();
    this.scaler = new ThermalScaler();

    // Rendering and processing settings
    this.currentPaletteKey = 'IRONBOW';
    this.rotationAngle = 90; // Default: 90 degrees clockwise
    this.scalingMode = 'TAAU'; // Default: Firmware TAAU scaling
    this.liveDenoiseEnabled = true; // Firmware Peak-Preserving Median denoise
    this.peakThreshold = 2.0; // °C
    this.autoRangeFloor = 5.0; // THERMAL_MIN_RANGE_SPAN from firmware
    this.flipVertical = true;

    // Stream metrics
    this.frameCount = 0;
    this.fps = 0;
    this.lastFpsTime = performance.now();
    this.fpsCounter = 0;
    this.latestRawFrame = null;
    this.latestFilteredFrame = null;

    // Interactive probe
    this.probeX = 12;
    this.probeY = 16;
    this.canvasHovered = false;

    // Video Recording state
    this.isRecording = false;
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordTimerInterval = null;
    this.recordStartTime = 0;
    this.selectedMimeType = '';
    this._toastTimeout = null;

    // UI elements
    this.container = null;
    this.canvas = null;
    this.ctx = null;
    this.colorbarCanvas = null;
    this.colorbarCtx = null;
    this.displayImgData = null;

    this.shutterFlash = null;
    this.btnCapture = null;
    this.btnRecord = null;
    this.recordIcon = null;
    this.recordLabel = null;
    this.btnSettings = null;
    this.btnSettingsToggle = null;
    this.settingsDrawer = null;
    this.settingsBackdrop = null;
    this.settingsClose = null;
    this.rotationSelect = null;
    this.scalingSelect = null;
    this.toastElem = null;

    this._initDom();
    this._bindEvents();
  }

  _initDom() {
    this.container = document.getElementById('thermal-stream-panel');
    this.canvas = document.getElementById('thermal-canvas');
    this.ctx = this.canvas.getContext('2d');
    this.colorbarCanvas = document.getElementById('thermal-colorbar');
    this.colorbarCtx = this.colorbarCanvas.getContext('2d');

    this.shutterFlash = document.getElementById('stream-shutter-flash');
    this.btnCapture = document.getElementById('stream-btn-capture');
    this.btnRecord = document.getElementById('stream-btn-record');
    this.recordIcon = document.getElementById('stream-record-icon');
    this.recordLabel = document.getElementById('stream-record-label');
    this.btnSettings = document.getElementById('stream-btn-settings');
    this.btnSettingsToggle = document.getElementById('stream-btn-settings-toggle');
    this.settingsDrawer = document.getElementById('stream-settings-drawer');
    this.settingsBackdrop = document.getElementById('stream-settings-backdrop');
    this.settingsClose = document.getElementById('stream-settings-close');
    this.rotationSelect = document.getElementById('stream-rotation-select');
    this.scalingSelect = document.getElementById('stream-scaling-select');
    this.toastElem = document.getElementById('stream-toast');

    // Configure high-performance ThermalScaler for display canvas resolution
    const {width: rotW, height: rotH} = this._getRotatedDimensions(this.rotationAngle);
    this.scaler.reconfigureViewport(this.canvas.width, this.canvas.height, rotW, rotH);
    this.displayImgData = this.ctx.createImageData(this.canvas.width, this.canvas.height);

    // Initial splash screen on canvas
    this._renderSplash();
  }

  _getRotatedDimensions(angle) {
    if (angle === 90 || angle === 270) {
      return {width: THERMAL_RAW_HEIGHT, height: THERMAL_RAW_WIDTH}; // 24x32
    }
    return {width: THERMAL_RAW_WIDTH, height: THERMAL_RAW_HEIGHT}; // 32x24
  }

  _bindEvents() {
    // When stream starts -> notify parent to show view switcher and switch to stream view
    this.client.onStreamStart(() => {
      if (this.options.onStreamToggleVisibility) {
        this.options.onStreamToggleVisibility(true);
      }
      this.show();
    });

    // Client frame callback
    this.client.onFrame((frame) => {
      this._handleIncomingFrame(frame);
    });

    // Client text callback
    this.client.onText((text) => {
      if (this.options.onLog) {
        this.options.onLog(text, 'incoming');
      }
    });

    // Client connection status callback
    this.client.onStatus((connected, message) => {
      if (!connected) {
        if (this.isRecording) {
          this.stopRecording();
        }
        if (this.options.onStreamToggleVisibility) {
          this.options.onStreamToggleVisibility(false);
        }
        this.hide();
        this._renderSplash();
      }
      if (this.options.onLog && message) {
        this.options.onLog(message);
      }
    });

    // Header close / switch to terminal button
    const btnClose = document.getElementById('stream-btn-close');
    if (btnClose) {
      btnClose.addEventListener('click', () => {
        if (this.options.onClose) {
          this.options.onClose();
        } else {
          this.hide();
        }
      });
    }

    // Bottom action bar: Capture picture
    if (this.btnCapture) {
      this.btnCapture.addEventListener('click', () => {
        this.captureSnapshot();
      });
    }

    // Bottom action bar: Start/Stop Recording
    if (this.btnRecord) {
      this.btnRecord.addEventListener('click', () => {
        this.toggleRecording();
      });
    }

    // Settings drawer toggle buttons
    if (this.btnSettings) {
      this.btnSettings.addEventListener('click', () => {
        this.toggleSettings();
      });
    }
    if (this.btnSettingsToggle) {
      this.btnSettingsToggle.addEventListener('click', () => {
        this.toggleSettings();
      });
    }
    if (this.settingsClose) {
      this.settingsClose.addEventListener('click', () => {
        this.closeSettings();
      });
    }
    if (this.settingsBackdrop) {
      this.settingsBackdrop.addEventListener('click', () => {
        this.closeSettings();
      });
    }

    // Palette selector
    const paletteSelect = document.getElementById('stream-palette-select');
    if (paletteSelect) {
      paletteSelect.addEventListener('change', (e) => {
        this.currentPaletteKey = e.target.value;
        this._updateColorbar();
        if (this.latestFilteredFrame) {
          this._renderThermalFrame(this.latestFilteredFrame);
        }
      });
    }

    // Rotation selector
    if (this.rotationSelect) {
      this.rotationSelect.addEventListener('change', (e) => {
        this.setRotation(parseInt(e.target.value, 10));
      });
    }

    // Scaling Algorithm selector
    if (this.scalingSelect) {
      this.scalingSelect.addEventListener('change', (e) => {
        this.scalingMode = e.target.value;
        this.scaler.reset();
        if (this.latestFilteredFrame) {
          this._renderThermalFrame(this.latestFilteredFrame);
        }
      });
    }

    // Live Denoise toggle
    const btnDenoise = document.getElementById('btn-toggle-denoise');
    if (btnDenoise) {
      btnDenoise.addEventListener('click', () => {
        this.liveDenoiseEnabled = !this.liveDenoiseEnabled;
        btnDenoise.classList.toggle('active', this.liveDenoiseEnabled);
        btnDenoise.textContent = `Live Denoise: ${this.liveDenoiseEnabled ? 'ON' : 'OFF'}`;
        this.scaler.reset();
        if (this.latestRawFrame) {
          this._processAndRender(this.latestRawFrame);
        }
      });
    }

    // Vertical Flip toggle
    const btnFlip = document.getElementById('btn-toggle-flip');
    if (btnFlip) {
      btnFlip.addEventListener('click', () => {
        this.flipVertical = !this.flipVertical;
        btnFlip.classList.toggle('active', this.flipVertical);
        btnFlip.textContent = `Flip: ${this.flipVertical ? 'V' : 'OFF'}`;
        this.scaler.reset();
        if (this.latestRawFrame) {
          this._processAndRender(this.latestRawFrame);
        }
      });
    }

    // Canvas cursor probe interactions
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const scaleX = this.canvas.width / rect.width;
      const scaleY = this.canvas.height / rect.height;
      const canvasX = (e.clientX - rect.left) * scaleX;
      const canvasY = (e.clientY - rect.top) * scaleY;

      const {width: rotW, height: rotH} = this._getRotatedDimensions(this.rotationAngle);
      const pixelSizeX = this.canvas.width / rotW;
      const pixelSizeY = this.canvas.height / rotH;

      this.probeX = Math.max(0, Math.min(rotW - 1, Math.floor(canvasX / pixelSizeX)));
      this.probeY = Math.max(0, Math.min(rotH - 1, Math.floor(canvasY / pixelSizeY)));
      this.canvasHovered = true;

      if (this.latestFilteredFrame) {
        this._renderThermalFrame(this.latestFilteredFrame);
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.canvasHovered = false;
      if (this.latestFilteredFrame) {
        this._renderThermalFrame(this.latestFilteredFrame);
      }
    });

    // Draw initial colorbar
    this._updateColorbar();
  }

  show() {
    if (this.container && this.container.classList.contains('hidden')) {
      this.container.classList.remove('hidden');
    }
  }

  hide() {
    if (this.container) {
      this.container.classList.add('hidden');
      this.closeSettings();
    }
  }

  toggle() {
    if (this.container) {
      if (this.isOpen()) {
        this.hide();
      } else {
        this.show();
      }
    }
  }

  isOpen() {
    return this.container && !this.container.classList.contains('hidden');
  }

  toggleSettings() {
    if (!this.settingsDrawer) return;
    if (this.settingsDrawer.classList.contains('hidden')) {
      this.openSettings();
    } else {
      this.closeSettings();
    }
  }

  openSettings() {
    if (this.settingsDrawer) {
      this.settingsDrawer.classList.remove('hidden');
    }
    if (this.settingsBackdrop) {
      this.settingsBackdrop.classList.remove('hidden');
    }
  }

  closeSettings() {
    if (this.settingsDrawer) {
      this.settingsDrawer.classList.add('hidden');
    }
    if (this.settingsBackdrop) {
      this.settingsBackdrop.classList.add('hidden');
    }
  }

  showToast(message) {
    if (!this.toastElem) return;
    this.toastElem.textContent = message;
    this.toastElem.classList.remove('hidden');
    clearTimeout(this._toastTimeout);
    this._toastTimeout = setTimeout(() => {
      this.toastElem.classList.add('hidden');
    }, 2500);
  }

  setRotation(angle) {
    this.rotationAngle = angle;
    const {width: rotW, height: rotH} = this._getRotatedDimensions(angle);

    // Resize display canvas
    if (angle === 90 || angle === 270) {
      this.canvas.width = 480;
      this.canvas.height = 640;
      this.colorbarCanvas.height = 640;
    } else {
      this.canvas.width = 640;
      this.canvas.height = 480;
      this.colorbarCanvas.height = 480;
    }

    // Reset probe coordinates within new bounds
    this.probeX = Math.min(this.probeX, rotW - 1);
    this.probeY = Math.min(this.probeY, rotH - 1);

    // Reconfigure ThermalScaler and display buffer
    this.scaler.reconfigureViewport(this.canvas.width, this.canvas.height, rotW, rotH);
    this.displayImgData = this.ctx.createImageData(this.canvas.width, this.canvas.height);

    this._updateColorbar();

    if (this.latestRawFrame) {
      this._processAndRender(this.latestRawFrame);
    } else {
      this._renderSplash();
    }
  }

  _rotateFrame(src, angle) {
    const rawW = THERMAL_RAW_WIDTH; // 32
    const rawH = THERMAL_RAW_HEIGHT; // 24

    if (angle === 90) {
      // Rotate 90 degrees clockwise (32x24 -> 24x32)
      const dst = new Float32Array(src.length);
      for (let y = 0; y < rawH; y++) {
        const srcRow = y * rawW;
        for (let x = 0; x < rawW; x++) {
          const rotX = rawH - 1 - y; // 23 - y
          const rotY = x;
          dst[rotY * rawH + rotX] = src[srcRow + x];
        }
      }
      return dst;
    } else if (angle === 180) {
      // Rotate 180 degrees (32x24 -> 32x24)
      const dst = new Float32Array(src.length);
      for (let y = 0; y < rawH; y++) {
        const srcRow = y * rawW;
        for (let x = 0; x < rawW; x++) {
          const rotX = rawW - 1 - x;
          const rotY = rawH - 1 - y;
          dst[rotY * rawW + rotX] = src[srcRow + x];
        }
      }
      return dst;
    } else if (angle === 270) {
      // Rotate 270 degrees clockwise (32x24 -> 24x32)
      const dst = new Float32Array(src.length);
      for (let y = 0; y < rawH; y++) {
        const srcRow = y * rawW;
        for (let x = 0; x < rawW; x++) {
          const rotX = y;
          const rotY = rawW - 1 - x;
          dst[rotY * rawH + rotX] = src[srcRow + x];
        }
      }
      return dst;
    }

    return src;
  }

  _handleIncomingFrame(frame) {
    this.latestRawFrame = frame;
    this.frameCount++;
    this.fpsCounter++;

    const now = performance.now();
    if (now - this.lastFpsTime >= 1000) {
      this.fps = (this.fpsCounter * 1000) / (now - this.lastFpsTime);
      this.fpsCounter = 0;
      this.lastFpsTime = now;
      const fpsElem = document.getElementById('stream-fps');
      if (fpsElem) {
        fpsElem.textContent = `${this.fps.toFixed(1)} FPS`;
      }
    }

    this._processAndRender(frame);
  }

  _processAndRender(rawFrame) {
    // 1. Vertical flip (in raw coordinate space)
    let oriented = rawFrame;
    if (this.flipVertical) {
      const flipped = new Float32Array(oriented.length);
      for (let y = 0; y < THERMAL_RAW_HEIGHT; y++) {
        const srcRow = (THERMAL_RAW_HEIGHT - 1 - y) * THERMAL_RAW_WIDTH;
        const dstRow = y * THERMAL_RAW_WIDTH;
        for (let x = 0; x < THERMAL_RAW_WIDTH; x++) {
          flipped[dstRow + x] = oriented[srcRow + x];
        }
      }
      oriented = flipped;
    }

    // 2. Rotate frame according to configured angle (Default: 90° Clockwise)
    const rotated = this._rotateFrame(oriented, this.rotationAngle);
    const {width: rotW, height: rotH} = this._getRotatedDimensions(this.rotationAngle);

    // 3. Live Denoise: 3x3 Peak-Preserving Edge-Preserving Median filter
    let processed = rotated;
    if (this.liveDenoiseEnabled) {
      const denoised = new Float32Array(rotated.length);
      filterPeakPreservingMedian(rotated, denoised, this.peakThreshold, rotW, rotH);
      processed = denoised;
    }

    this.latestFilteredFrame = processed;
    this._renderThermalFrame(processed);
  }

  _renderThermalFrame(frame) {
    let minTemp = Infinity;
    let maxTemp = -Infinity;

    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      if (v < minTemp) minTemp = v;
      if (v > maxTemp) maxTemp = v;
    }

    // Auto-range floor clamping (5.0°C THERMAL_MIN_RANGE_SPAN from firmware)
    let range = maxTemp - minTemp;
    let effectiveMin = minTemp;
    if (range < this.autoRangeFloor) {
      const mid = 0.5 * (minTemp + maxTemp);
      range = this.autoRangeFloor;
      effectiveMin = mid - 0.5 * range;
    }
    const invRange = 255.0 / range;

    const {width: rotW, height: rotH} = this._getRotatedDimensions(this.rotationAngle);
    const centerIdx = Math.floor(rotH / 2) * rotW + Math.floor(rotW / 2);
    const centerTemp = frame[centerIdx];
    const probeIdx = this.probeY * rotW + this.probeX;
    const probeTemp = frame[probeIdx] !== undefined ? frame[probeIdx] : centerTemp;

    // Update telemetry chips
    const maxElem = document.getElementById('stream-max');
    if (maxElem) maxElem.textContent = `MAX: ${maxTemp.toFixed(1)}°C`;

    const ctrElem = document.getElementById('stream-ctr');
    if (ctrElem) ctrElem.textContent = `CTR: ${centerTemp.toFixed(1)}°C`;

    const minElem = document.getElementById('stream-min');
    if (minElem) minElem.textContent = `MIN: ${minTemp.toFixed(1)}°C`;

    const probeElem = document.getElementById('stream-probe');
    if (probeElem) {
      probeElem.textContent = `PROBE (${this.probeX},${this.probeY}): ${probeTemp.toFixed(1)}°C`;
    }

    const cbMax = document.getElementById('colorbar-max');
    if (cbMax) cbMax.textContent = `${maxTemp.toFixed(0)}°`;

    const cbMid = document.getElementById('colorbar-mid');
    if (cbMid) cbMid.textContent = `${((maxTemp + minTemp) * 0.5).toFixed(0)}°`;

    const cbMin = document.getElementById('colorbar-min');
    if (cbMin) cbMin.textContent = `${minTemp.toFixed(0)}°`;

    // Render scaled image directly to displayImgData using ThermalScaler
    const colormap = THERMAL_COLORMAPS[this.currentPaletteKey] || THERMAL_COLORMAPS.IRONBOW;
    this.scaler.render(
        this.scalingMode,
        frame,
        this.displayImgData,
        effectiveMin,
        invRange,
        colormap.lut,
    );
    this.ctx.putImageData(this.displayImgData, 0, 0);

    // Center crosshair marker
    const targetW = this.canvas.width;
    const targetH = this.canvas.height;
    const centerX = targetW / 2;
    const centerY = targetH / 2;
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(centerX - 8, centerY);
    this.ctx.lineTo(centerX + 8, centerY);
    this.ctx.moveTo(centerX, centerY - 8);
    this.ctx.lineTo(centerX, centerY + 8);
    this.ctx.stroke();

    // Cursor probe crosshair
    if (this.canvasHovered) {
      const pixelSizeX = targetW / rotW;
      const pixelSizeY = targetH / rotH;
      const cursorX = (this.probeX + 0.5) * pixelSizeX;
      const cursorY = (this.probeY + 0.5) * pixelSizeY;

      this.ctx.strokeStyle = '#00e5ff';
      this.ctx.lineWidth = 1.5;
      this.ctx.beginPath();
      this.ctx.moveTo(cursorX - 10, cursorY);
      this.ctx.lineTo(cursorX + 10, cursorY);
      this.ctx.moveTo(cursorX, cursorY - 10);
      this.ctx.lineTo(cursorX, cursorY + 10);
      this.ctx.stroke();

      this.ctx.beginPath();
      this.ctx.arc(cursorX, cursorY, 5, 0, Math.PI * 2);
      this.ctx.stroke();
    }
  }

  _updateColorbar() {
    const colormap = THERMAL_COLORMAPS[this.currentPaletteKey] || THERMAL_COLORMAPS.IRONBOW;
    const lut = colormap.lut;
    const w = this.colorbarCanvas.width;
    const h = this.colorbarCanvas.height;
    const imgData = this.colorbarCtx.createImageData(w, h);
    const data32 = new Uint32Array(imgData.data.buffer);

    for (let y = 0; y < h; y++) {
      const norm = Math.max(0, Math.min(255, Math.floor(((h - 1 - y) / (h - 1)) * 255)));
      const color = lut[norm];
      const rowOffset = y * w;
      for (let x = 0; x < w; x++) {
        data32[rowOffset + x] = color;
      }
    }

    this.colorbarCtx.putImageData(imgData, 0, 0);
  }

  _renderSplash() {
    const w = this.canvas.width;
    const h = this.canvas.height;

    this.ctx.fillStyle = '#0a0a0a';
    this.ctx.fillRect(0, 0, w, h);

    this.ctx.font = '14px "Roboto Mono", monospace';
    this.ctx.fillStyle = '#757575';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('THERMOPHASE STREAM | Ready', w / 2, h / 2);
    this.ctx.textAlign = 'left';
  }

  captureSnapshot() {
    // Visual shutter flash effect
    if (this.shutterFlash) {
      this.shutterFlash.classList.add('flash-active');
      setTimeout(() => {
        this.shutterFlash.classList.remove('flash-active');
      }, 180);
    }

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const link = document.createElement('a');
    link.download = `thermophase-snapshot-${timestamp}.png`;
    link.href = this.canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    this.showToast('Snapshot saved & downloaded');
  }

  toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  startRecording() {
    if (typeof MediaRecorder === 'undefined' || !this.canvas.captureStream) {
      this.showToast('Recording is not supported in this browser');
      return;
    }

    // Determine optimal supported video MIME type
    const candidateTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];

    let chosenMime = '';
    for (const mime of candidateTypes) {
      if (MediaRecorder.isTypeSupported(mime)) {
        chosenMime = mime;
        break;
      }
    }

    try {
      const stream = this.canvas.captureStream(30);
      const options = chosenMime ? {mimeType: chosenMime} : {};
      this.recordedChunks = [];
      this.selectedMimeType = chosenMime;
      this.mediaRecorder = new MediaRecorder(stream, options);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this._saveRecording();
      };

      this.mediaRecorder.start(100);
      this.isRecording = true;
      this.recordStartTime = Date.now();

      if (this.btnRecord) {
        this.btnRecord.classList.add('recording');
        if (this.recordIcon) this.recordIcon.textContent = 'stop';
        if (this.recordLabel) this.recordLabel.textContent = 'Stop (00:00)';
      }

      this.recordTimerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - this.recordStartTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        if (this.recordLabel) {
          this.recordLabel.textContent = `Stop (${mins}:${secs})`;
        }
      }, 1000);

      this.showToast('Recording started');
    } catch (err) {
      this.showToast(`Recording error: ${err.message}`);
    }
  }

  stopRecording() {
    if (!this.isRecording) return;

    if (this.recordTimerInterval) {
      clearInterval(this.recordTimerInterval);
      this.recordTimerInterval = null;
    }

    this.isRecording = false;

    if (this.btnRecord) {
      this.btnRecord.classList.remove('recording');
      if (this.recordIcon) this.recordIcon.textContent = 'fiber_manual_record';
      if (this.recordLabel) this.recordLabel.textContent = 'Record';
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
  }

  _saveRecording() {
    if (this.recordedChunks.length === 0) return;

    const mime = this.selectedMimeType || 'video/webm';
    const blob = new Blob(this.recordedChunks, {type: mime});
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';

    const link = document.createElement('a');
    link.download = `thermophase-recording-${timestamp}.${ext}`;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    setTimeout(() => URL.revokeObjectURL(url), 2000);
    this.recordedChunks = [];
    this.showToast('Recording saved & downloaded');
  }

  ingestChunk(chunk) {
    this.client.ingestChunk(chunk);
  }
}

// Attach globally for browser usage
window.ThermalCameraClient = ThermalCameraClient;
window.ThermalStreamWindow = ThermalStreamWindow;
window.ThermalFilters = {filterPeakPreservingMedian};
