import { Capacitor, registerPlugin } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import installNative from './native-bridge.js';

const tracking = Capacitor.isPluginAvailable('FleetTracking') ? registerPlugin('FleetTracking') : null;
installNative(window, Capacitor, Geolocation, tracking);
