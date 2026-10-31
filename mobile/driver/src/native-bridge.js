'use strict';

// Loaded before auth.js: its existing wrapper still attaches the Bearer token
// only to local /api requests. Only those requests are forwarded to Render.
module.exports = function installNative(win, capacitor, geo, tracking = null) {
  if (!capacitor.isNativePlatform()) return;
  const remote = 'https://fleetchile-pro.onrender.com';
  const origin = win.location.origin;
  const fetchNative = win.fetch.bind(win);
  win.fetch = (input, options = {}) => {
    const request = typeof input === 'string' || input instanceof URL ? null : input;
    const url = new URL(request ? request.url : String(input), win.location.href);
    if (url.origin === origin && url.pathname.startsWith('/api/')) {
      // Native HTTP avoids weakening the backend's CORS or tenant policies.
      const target = remote + url.pathname + url.search;
      return fetchNative(request ? new Request(target, request) : target, options);
    }
    if (url.origin !== origin && !['blob:', 'data:'].includes(url.protocol)) {
      return Promise.reject(new TypeError('Destino de red no permitido en la app'));
    }
    return fetchNative(input, options);
  };

  const watches = new Map();
  let sequence = 0;
  const geoError = error => ({
    code: /permission|denied|0003/i.test(error?.message + ' ' + error?.code) ? 1 : 2,
    message: error?.message || 'No se pudo obtener ubicación'
  });
  const settings = options => ({
    enableHighAccuracy: options?.enableHighAccuracy === true,
    timeout: Math.max(10000, Math.min(Number(options?.timeout) || 15000, 60000)),
    maximumAge: Math.max(0, Number(options?.maximumAge) || 0)
  });
  async function permission() {
    let state = await geo.checkPermissions();
    if (state.location !== 'granted' && state.coarseLocation !== 'granted') {
      state = await geo.requestPermissions({ permissions: ['location'] });
    }
    if (state.location !== 'granted' && state.coarseLocation !== 'granted') {
      throw Object.assign(new Error('Permiso de ubicación denegado'), { code: '0003' });
    }
  }
  Object.defineProperty(win.navigator, 'geolocation', { configurable: true, value: {
    getCurrentPosition(success, failure, options) {
      permission().then(() => geo.getCurrentPosition(settings(options)))
        .then(success, error => failure?.(geoError(error)));
    },
    watchPosition(success, failure, options) {
      const key = ++sequence, entry = { id: null, stopped: false };
      watches.set(key, entry);
      (async () => {
        try {
          await permission();
          if (entry.stopped) return;
          const id = await geo.watchPosition(settings(options), (position, error) => {
            if (entry.stopped) return;
            if (error) failure?.(geoError(error));
            else if (position) success(position);
          });
          entry.id = id;
          if (entry.stopped) await geo.clearWatch({ id });
        } catch (error) { if (!entry.stopped) failure?.(geoError(error)); }
      })();
      return key;
    },
    clearWatch(key) {
      const entry = watches.get(key);
      if (!entry) return;
      entry.stopped = true;
      watches.delete(key);
      if (entry.id !== null) geo.clearWatch({ id: entry.id }).catch(() => {});
    }
  }});
  // Browser permission state does not represent Android runtime permissions.
  const permissions = win.navigator.permissions;
  if (permissions?.query) {
    const query = permissions.query.bind(permissions);
    permissions.query = descriptor => descriptor.name === 'geolocation'
      ? geo.checkPermissions().then(state => ({
        state: state.location === 'granted' || state.coarseLocation === 'granted' ? 'granted' : 'prompt',
        onchange: null
      })) : query(descriptor);
  }
  const available = !!tracking && capacitor.isPluginAvailable?.('FleetTracking') === true;
  if (available) {
    win.FleetTracking = Object.freeze({
      start: options => tracking.start({ tripId: String(options?.tripId ?? ''), token: options?.token }),
      stop: () => tracking.stop(),
      status: () => tracking.status()
    });
  }
  win.FleetNative = Object.freeze({ platform: 'android', backgroundGps: available });
};
