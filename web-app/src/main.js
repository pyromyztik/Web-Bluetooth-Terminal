// UI elements.
const deviceNameLabel = document.getElementById('device-name');
const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const themeToggleButton = document.getElementById('theme-toggle');
const terminalContainer = document.getElementById('terminal');
const messageForm = document.getElementById('message-form');
const messageInput = document.getElementById('message-input');

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
  terminalContainer.insertAdjacentHTML('beforeend', `<div${type && ` class="${type}"`}>${message}</div>`);

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

// Bind event listeners to the UI elements.
connectButton.addEventListener('click', async () => {
  try {
    // Open the browser Bluetooth device picker to select a device if none was previously selected, establish a
    // connection with the selected device, and initiate communication.
    await bluetoothTerminal.connect();
  } catch (error) {
    logToTerminal(error, 'error');

    return;
  }

  // Retrieve the name of the currently connected device.
  deviceNameLabel.textContent = bluetoothTerminal.getDeviceName() || defaultDeviceName;
});

disconnectButton.addEventListener('click', () => {
  try {
    // Disconnect from the currently connected device and clean up associated resources.
    bluetoothTerminal.disconnect();
  } catch (error) {
    logToTerminal(error, 'error');

    return;
  }

  deviceNameLabel.textContent = defaultDeviceName;
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

