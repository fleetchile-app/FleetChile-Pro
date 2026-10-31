import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import installNative from './native-bridge.js';

installNative(window, Capacitor, Geolocation);
