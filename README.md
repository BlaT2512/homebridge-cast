<p align="center">
  <img src="https://raw.githubusercontent.com/homebridge/branding/6ef3a1685e79f79a2ecdcc83824e53775ec0475d/logos/homebridge-wordmark-logo-horizontal.svg" width="500">
</p>

# homebridge-chromecast
![npm](https://img.shields.io/npm/v/blat2512/homebridge-chromecast)

Homebridge Chromecast is a [Homebridge](https://github.com/homebridge/homebridge) plugin for controlling Google TVs, Android TVs or any Google Cast devices.

For Google/Android TVs, a TV service is exposed allowing the device to be powered on/off, the current application to be viewed/changed and remote control from your phone in control centre.

For all devices, a light service can be exposed for controlling media streaming status and volume.

A motion sensor service can also be exposed which becomes active when the Chromecast is streaming, useful for automations.

# Installation
Please ensure you are running the latest version of Homebridge (heres how to [install](https://github.com/homebridge/homebridge/wiki) if you haven't already). To install this plugin, go to the Homebridge web interface Plugins page and search for `Chromecast`. Alternatively, from command line run:
```
npm i -g @blat2512/homebridge-chromecast
```

# Setup
Configure your devices in Homebridge Web Interface > Plugins > Homebridge Chromecast > Settings

Name or IP: The device name of your Chromecast (as seen in Google Home app) - or IP address if static

Display Name: Optional different display name for your Chromecast in Homebridge and the Home app (leave blank for same as above)

Device Type: Select Android TV for Android TVs, Chromecast Streaming Stick for Google TVs and Chromecast Audio for other Google Cast devices

`Note: TV accessories must be added separately in the Home app, remember to click Add Accessory > More Options in the Home app and add it after adding a Android/Google TV in the config`

Check on Volume Service and/or Streaming Service to expose a lightbulb for media/volume control and/or motion sensor for streaming status, respectively

For Android/Google TVs, apps to show in Homekit can also be entered. Enter the app bundle identifier in App ID (e.g. com.netflix.ninja), and optionally the apps deeplink domain in App Link for the ability to open the app from Homekit (e.g. https://www.netflix.com/title.*)

`IMPORTANT: For Android/Google TVs, you will also need to obtain an authentication certificate, see the below section`

# TV Authentication
For Android/Google TV types, you will need to obtain an authentication certificate using the included `certgen.js` script. This can be run with the following command from the command line:
```
node $(npm root -g)/@blat2512/homebridge-chromecast/certgen.js
```
The script will prompt you to enter your device name, which should be the same as the Name set in the plugin config (the exact name of the device in the Google Home app).

A code will then be displayed on your TV screen and the script will prompt you to enter it. It will then output the authentication certificate if successful.

This should be copied into the config for the TV by  going to the Homebridge Web Interface > Plugins > Homebridge Chromecast > ... menu > JSON Config

Within the JSON Config, find your device and paste the certificate as the `tvCert` property underneath the other properties (remove all the +s in the JSON output to create single string for the `key` and `cert`).

An example Android/Google TV config:
```
{
    "name": "Living Room TV",
    "displayName": "Living Room Android TV",
    "type": "tv",
    "volumeService": true,
    "motionService": false,
    "tvApps": [
        {
            "id": "com.google.android.apps.tv.launcherx",
            "name": "Home"
        },
        {
            "link": "https://www.netflix.com/title.*",
            "id": "com.netflix.ninja",
            "name": "Netflix"
        },
        {
            "id": "com.google.android.youtube.tv",
            "name": "YouTube"
        }
    ],
    "tvCert": {
        "key": "-----BEGIN RSA PRIVATE KEY-----\r\nMIIEogIBA.......hdU6z34m11tFjjry2wec4wxA=\r\n-----END RSA PRIVATE KEY-----\r\n",
        "cert": "-----BEGIN CERTIFICATE-----\r\nnMIIEogIBA.......4m11tFjjry2wec4wxA\r\n-----END CERTIFICATE-----\r\n"
    }
}
```
A custom settings UI for the Homebridge web interface will be coming soon to automatically configure TV accessories when added
