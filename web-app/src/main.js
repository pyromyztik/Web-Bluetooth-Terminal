// UI elements.
const deviceNameLabel = document.getElementById('device-name');
const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const exportButton = document.getElementById('export');
const themeToggleButton = document.getElementById('theme-toggle');
const terminalContainer = document.getElementById('terminal');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

// Log history and timestamps.
const logHistory = [];

const formatTime = (date = new Date(), withMs = false) => {
  const pad = (num, length = 2) => String(num).padStart(length, '0');
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  if (withMs) {
    const ms = pad(date.getMilliseconds(), 3);
    return `${hours}:${minutes}:${seconds}.${ms}`;
  }

  return `${hours}:${minutes}:${seconds}`;
};

// Theme management.
const getStoredTheme = () => {
  try {
    return localStorage.getItem('theme');
  } catch {
    return null;
  }
};

const setStoredTheme = (theme) => {
  try {
    localStorage.setItem('theme', theme);
  } catch {
    // Ignore storage errors.
  }
};

const getPreferredTheme = () => {
  const storedTheme = getStoredTheme();
  if (storedTheme === 'dark' || storedTheme === 'light') {
    return storedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const applyTheme = (theme) => {
  document.documentElement.setAttribute('data-theme', theme);

  const isDark = theme === 'dark';
  const icon = themeToggleButton.querySelector('i');
  if (icon) {
    icon.textContent = isDark ? 'light_mode' : 'dark_mode';
  }

  const label = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  themeToggleButton.setAttribute('aria-label', label);
  themeToggleButton.setAttribute('title', label);

  const themeColorMeta = document.getElementById('theme-color-meta');
  if (themeColorMeta) {
    themeColorMeta.setAttribute('content', isDark ? '#121212' : '#ffffff');
  }
};

// Helpers.
const defaultDeviceName = 'Web Bluetooth Terminal';
const terminalAutoScrollingLimit = terminalContainer.offsetHeight / 2;
let isTerminalAutoScrolling = true;

const logToTerminal = (message, type = '') => {
  const now = new Date();
  const timeStr = formatTime(now);
  const timeWithMs = formatTime(now, true);

  logHistory.push({
    timestamp: timeWithMs,
    type,
    message: String(message),
  });

  const entryClass = type ? ` class="${type}"` : '';
  const entryHtml = `<div${entryClass}>` +
    `<span class="content">${message}</span>` +
    `<span class="timestamp">[${timeStr}]</span>` +
    `</div>`;

  terminalContainer.insertAdjacentHTML('beforeend', entryHtml);

  if (isTerminalAutoScrolling) {
    const scrollTop = terminalContainer.scrollHeight - terminalContainer.offsetHeight;

    if (scrollTop > 0) {
      terminalContainer.scrollTop = scrollTop;
    }
  }
};

// Create a BluetoothTerminal instance with the default configuration.
const bluetoothTerminal = new BluetoothTerminal({
  // serviceUuid: 0xFFE0,
  // characteristicUuid: 0xFFE1,
  // characteristicValueSize: 20,
  // receiveSeparator: '\n',
  // sendSeparator: '\n',
  // logLevel: 'log',
});

// Set a callback that will be called when an incoming message from the connected device is received.
bluetoothTerminal.onReceive((message) => {
  logToTerminal(message, 'incoming');
});

// Set a callback that will be called every time any log message is produced by the class, regardless of the log level
// set.
bluetoothTerminal.onLog((logLevel, method, message) => {
  // Ignore debug messages.
  if (logLevel === 'debug') {
    return;
  }

  logToTerminal(message);
});

// Connection state management.
const updateConnectionState = (connected) => {
  if (connected) {
    const deviceName = bluetoothTerminal.getDeviceName() || defaultDeviceName;
    deviceNameLabel.textContent = deviceName;
    connectButton.hidden = true;
    disconnectButton.hidden = false;
    disconnectButton.setAttribute('title', `Disconnect from ${deviceName}`);
  } else {
    deviceNameLabel.textContent = defaultDeviceName;
    connectButton.hidden = false;
    disconnectButton.hidden = true;
  }
};

bluetoothTerminal.onConnect(() => {
  updateConnectionState(true);
});

bluetoothTerminal.onDisconnect(() => {
  updateConnectionState(false);
});

// Bind event listeners to the UI elements.
connectButton.addEventListener('click', async () => {
  try {
    // Open the browser Bluetooth device picker to select a device if none was previously selected, establish a
    // connection with the selected device, and initiate communication.
    await bluetoothTerminal.connect();
  } catch (error) {
    logToTerminal(error, 'error');
  }
});

disconnectButton.addEventListener('click', () => {
  try {
    // Disconnect from the currently connected device and clean up associated resources.
    bluetoothTerminal.disconnect();
  } catch (error) {
    logToTerminal(error, 'error');
  }
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  try {
    // Send a message to the connected device.
    await bluetoothTerminal.send(messageInput.value);
  } catch (error) {
    logToTerminal(error, 'error');

    return;
  }

  logToTerminal(messageInput.value, 'outgoing');

  messageInput.value = '';
  messageInput.focus();
});

// Enable terminal auto-scrolling if it scrolls beyond the bottom.
terminalContainer.addEventListener('scroll', () => {
  const scrollTopOffset = terminalContainer.scrollHeight - terminalContainer.offsetHeight - terminalAutoScrollingLimit;

  isTerminalAutoScrolling = (scrollTopOffset < terminalContainer.scrollTop);
});

// Toggle between dark and light themes.
themeToggleButton.addEventListener('click', () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || getPreferredTheme();
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';

  setStoredTheme(newTheme);
  applyTheme(newTheme);
});

// Sync with system theme changes when no preference is saved.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
  if (!getStoredTheme()) {
    applyTheme(event.matches ? 'dark' : 'light');
  }
});

// Initialize theme state.
applyTheme(document.documentElement.getAttribute('data-theme') || getPreferredTheme());

// Export log to text file.
const exportLog = () => {
  if (logHistory.length === 0) {
    logToTerminal('No log entries to export', 'error');

    return;
  }

  const typePrefixes = {
    incoming: '[IN] ',
    outgoing: '[OUT] ',
    error: '[ERROR] ',
  };

  const lines = logHistory.map((entry) => {
    const prefix = typePrefixes[entry.type] || '';

    return `[${entry.timestamp}] ${prefix}${entry.message}`;
  });

  const deviceName = bluetoothTerminal.getDeviceName() || defaultDeviceName;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dateStamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const header = [
    'Web Bluetooth Terminal Log',
    `Device: ${deviceName}`,
    `Exported: ${dateStamp}`,
    '='.repeat(60),
    '',
  ].join('\r\n');

  const content = header + lines.join('\r\n') + '\r\n';
  const blob = new Blob([content], {type: 'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  const fileDate = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
    `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;

  anchor.href = url;
  anchor.download = `terminal-log-${fileDate}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
};

exportButton.addEventListener('click', () => {
  exportLog();
});


