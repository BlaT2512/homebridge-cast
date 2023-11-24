import { Client, DefaultMediaReceiver } from 'castv2-client';
import { AndroidRemote, RemoteKeyCode, RemoteDirection } from 'androidtv-remote';
import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { CastHomebridgePlatform } from './platform';

/**
 * Cast Platform Accessory
 * Connects to the Chromecast and exposes its services to Homebridge
 */
export class CastPlatformAccessory {
  private tvService: Service | undefined;
  private tvSpeakerService: Service | undefined;
  private volumeService: Service | undefined;
  private motionService: Service | undefined;

  private chromecastClient: Client;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectCounter = 0;

  private androidRemote: AndroidRemote | undefined;
  private remoteReconnectTimer: NodeJS.Timeout | undefined;
  private remoteReconnectCounter = 0;

  private castingStatus = 'STOP';
  private castingApplication: any | null;
  private castingMedia: any | null;
  private volume = 0;

  private remoteConnected = false;
  private powered = false;
  private muted = false;
  private appIndex = 0;

  constructor (
    private readonly platform: CastHomebridgePlatform,
    private readonly accessory: PlatformAccessory,
  ) {

    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Google')
      .setCharacteristic(this.platform.Characteristic.Model, this.accessory.context.model)
      .setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.accessory.UUID)
      .setCharacteristic(this.platform.Characteristic.SoftwareRevision, '1.0.0')
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, '@blat2512/homebridge-chromecast')
      .setCharacteristic(this.platform.Characteristic.HardwareRevision, 'Blake Tourneur');

    if (this.accessory.context.config.type !== 'audio') {
      // Create the TV service for powering on/off, application changing and remote
      this.tvService = this.accessory.getService(this.platform.Service.Television) ||
        this.accessory.addService(this.platform.Service.Television);
      this.tvService
        .setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName)
        .setCharacteristic(this.platform.Characteristic.ConfiguredName, this.accessory.displayName)
        .setCharacteristic(this.platform.Characteristic.SleepDiscoveryMode,
          this.platform.Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE)
        .setCharacteristic(this.platform.Characteristic.PowerModeSelection, this.platform.Characteristic.PowerModeSelection.SHOW);

      this.tvService.getCharacteristic(this.platform.Characteristic.Active) // Whether the chromecast is on
        .onGet(() => this.powered)
        .onSet(this.setActive.bind(this));

      let identifier = 0;
      if (this.accessory.context.config.tvApps) {
        for (const app of this.accessory.context.config.tvApps) {
          const uuid = this.platform.api.hap.uuid.generate(this.accessory.UUID + '-application-' + app.id);
          const service = this.accessory.getService(app.name) ||
            this.accessory.addService(this.platform.Service.InputSource, app.name, uuid);
          service.setCharacteristic(this.platform.Characteristic.ConfiguredName, app.name);
          service.setCharacteristic(this.platform.Characteristic.InputSourceType, this.platform.Characteristic.InputSourceType.APPLICATION);
          service.setCharacteristic(this.platform.Characteristic.IsConfigured, this.platform.Characteristic.IsConfigured.CONFIGURED);
          service.setCharacteristic(this.platform.Characteristic.Name, app.name);
          service.setCharacteristic(this.platform.Characteristic.CurrentVisibilityState,
            this.platform.Characteristic.CurrentVisibilityState.SHOWN);
          service.setCharacteristic(this.platform.Characteristic.Identifier, identifier);
          this.tvService.addLinkedService(service);
          identifier++;
        }
      }

      this.tvService.setCharacteristic(this.platform.Characteristic.ActiveIdentifier, 0); // The active app on the chromecast
      this.tvService.getCharacteristic(this.platform.Characteristic.ActiveIdentifier)
        .onGet(() => this.appIndex)
        .onSet(async newid => new Promise((resolve, reject) => {
          if (this.remoteConnected && this.accessory.context.config.tvApps) {
            const application = this.accessory.context.config.tvApps[newid as number];
            if (application.link) {
              try {
                this.androidRemote.sendAppLink(application.link);
                this.logDebug('Set Characteristic Active Identifier -> ' + newid);
                resolve();
              } catch (e) {
                reject(e);
              }
            } else {
              resolve();
              this.tvService?.updateCharacteristic(this.platform.Characteristic.ActiveIdentifier, this.appIndex);
            }
          } else {
            resolve();
            this.tvService?.updateCharacteristic(this.platform.Characteristic.ActiveIdentifier, this.appIndex);
          }
        }));

      const keys = {
        [this.platform.Characteristic.RemoteKey.REWIND]         : RemoteKeyCode.KEYCODE_MEDIA_REWIND,
        [this.platform.Characteristic.RemoteKey.FAST_FORWARD]   : RemoteKeyCode.KEYCODE_MEDIA_FAST_FORWARD,
        [this.platform.Characteristic.RemoteKey.NEXT_TRACK]     : RemoteKeyCode.KEYCODE_MEDIA_NEXT,
        [this.platform.Characteristic.RemoteKey.PREVIOUS_TRACK] : RemoteKeyCode.KEYCODE_MEDIA_PREVIOUS,
        [this.platform.Characteristic.RemoteKey.ARROW_UP]       : RemoteKeyCode.KEYCODE_DPAD_UP,
        [this.platform.Characteristic.RemoteKey.ARROW_DOWN]     : RemoteKeyCode.KEYCODE_DPAD_DOWN,
        [this.platform.Characteristic.RemoteKey.ARROW_LEFT]     : RemoteKeyCode.KEYCODE_DPAD_LEFT,
        [this.platform.Characteristic.RemoteKey.ARROW_RIGHT]    : RemoteKeyCode.KEYCODE_DPAD_RIGHT,
        [this.platform.Characteristic.RemoteKey.SELECT]         : RemoteKeyCode.KEYCODE_DPAD_CENTER,
        [this.platform.Characteristic.RemoteKey.BACK]           : RemoteKeyCode.KEYCODE_BACK,
        [this.platform.Characteristic.RemoteKey.EXIT]           : RemoteKeyCode.KEYCODE_HOME,
        [this.platform.Characteristic.RemoteKey.PLAY_PAUSE]     : RemoteKeyCode.KEYCODE_MEDIA_PLAY_PAUSE,
        [this.platform.Characteristic.RemoteKey.INFORMATION]    : RemoteKeyCode.KEYCODE_INFO,
      };
      this.tvService.getCharacteristic(this.platform.Characteristic.RemoteKey) // Remote buttons
        .onSet(key => {
          if (this.remoteConnected) {
            this.androidRemote.sendKey(keys[key as number], RemoteDirection.SHORT);
          }
        });

      this.tvService.getCharacteristic(this.platform.Characteristic.CurrentMediaState) // Whether media is currently playing
        .onGet(() => this.currentMediaState());

      this.tvService.getCharacteristic(this.platform.Characteristic.TargetMediaState) // Whether media is currently playing
        .onGet(() => this.targetMediaState())
        .onSet(async value => new Promise(resolve => {
          if (!this.castingMedia || this.castingMedia.session.isIdleScreen) {
            this.setIsCasting('STOP', value === 1);
            resolve();

          } else {
            try {
              if (value === 0 && this.castingStatus !== 'PLAYING' && this.castingStatus !== 'BUFFERING') {
                this.logDebug('Set Characteristic Media State -> ' + value);
                this.castingMedia.play(() => null);
              } else if (value === 1 && (this.castingStatus === 'PLAYING' || this.castingStatus === 'BUFFERING')) {
                this.logDebug('Set Characteristic Media State -> ' + value);
                this.castingMedia.pause(() => null);
              } else if (value === 2) {
                this.logDebug('Set Characteristic Media State -> ' + value);
                this.castingMedia.stop(() => null);
              }
            } catch(e) {
              this.setIsCasting('STOP', true);
              resolve();
              return;
            }

            this.setIsCasting(value === 0 ? 'PLAYING' : value === 1 ? 'PAUSED': 'STOP');
            resolve();
          }
        }));

      // Create the TV speaker service for volume and mute control
      this.tvSpeakerService = this.accessory.getService(this.platform.Service.TelevisionSpeaker) ||
        this.accessory.addService(this.platform.Service.TelevisionSpeaker);
      this.tvSpeakerService.setCharacteristic(this.platform.Characteristic.VolumeControlType,
        this.platform.Characteristic.VolumeControlType.ABSOLUTE);

      this.tvSpeakerService.getCharacteristic(this.platform.Characteristic.Mute) // Whether the chromecast is muted
        .onGet(() => this.muted)
        .onSet(mute => new Promise((resolve, reject) => {
          if (this.remoteConnected) {
            try {
              if (this.muted !== mute) {
                this.androidRemote.sendKey(RemoteKeyCode.KEYCODE_VOLUME_MUTE, RemoteDirection.SHORT);
              }
              this.logDebug('Set Characteristic Mute -> ' + mute);
              resolve();
            } catch (e) {
              reject(e);
            }
          } else {
            reject('Chromecast remote is disconnected');
          }
        }));

      this.tvSpeakerService.getCharacteristic(this.platform.Characteristic.Active) // Whether the chromecast is on
        .onGet(() => this.powered);
      //.onSet(this.setActive.bind(this));

      this.tvSpeakerService.getCharacteristic(this.platform.Characteristic.Volume) // Volume of the chromecast device
        .onGet(() => Math.floor(this.volume * 100))
        .onSet(value => new Promise((resolve, reject) => {
          if (this.chromecastClient) {
            this.logDebug('Set Characteristic Volume -> ' + value);
            try {
              this.chromecastClient.setVolume({ level: value as number / 100 }, () => resolve());
            } catch (e) {
              reject(new Error('Failed to set volume characteristic: ' + e as string));
            }
          }
        }));

      this.tvSpeakerService.getCharacteristic(this.platform.Characteristic.VolumeSelector) // Change the volume of the chromecast device
        .onSet(volumeSelector => new Promise((resolve, reject) => {
          if (this.remoteConnected) {
            this.logDebug('Set Characteristic VolumeSelector -> ' + volumeSelector);
            try {
              this.androidRemote.sendKey(volumeSelector === 0 ? RemoteKeyCode.KEYCODE_VOLUME_UP : RemoteKeyCode.KEYCODE_VOLUME_DOWN,
                RemoteDirection.SHORT);
              resolve();
            } catch (e) {
              reject(new Error('Failed to set volume characteristic: ' + e as string));
            }
          }
        }));
    }

    /*if (this.accessory.context.config.speakerService) {
      // Create the speaker service for volume, mute, play/pause and media control
      this.volumeService = this.accessory.getService(this.platform.Service.SmartSpeaker) ||
        this.accessory.addService(this.platform.Service.SmartSpeaker);
      this.volumeService.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);
      this.volumeService.setCharacteristic(this.platform.Characteristic.ConfiguredName, this.accessory.displayName);
      this.volumeService.setCharacteristic(this.platform.Characteristic.AirPlayEnable, true);

      this.volumeService.getCharacteristic(this.platform.Characteristic.CurrentMediaState) // Whether media is currently playing
        .onGet(() => this.currentMediaState());

      this.volumeService.getCharacteristic(this.platform.Characteristic.TargetMediaState) // Whether media is currently playing
        .onGet(() => this.targetMediaState())
        .onSet(async value => new Promise(resolve => {
          if (!this.chromecastClient || !this.castingMedia || this.castingMedia.session.isIdleScreen) {
            this.setIsCasting('STOP', value === 1);
            resolve();

          } else {
            try {
              if (value === 0 && this.castingStatus !== 'PLAYING' && this.castingStatus !== 'BUFFERING') {
                this.logDebug('Set Characteristic Media State -> ' + value);
                this.castingMedia.play(() => null);
              } else if (value === 1 && (this.castingStatus === 'PLAYING' || this.castingStatus === 'BUFFERING')) {
                this.logDebug('Set Characteristic Media State -> ' + value);
                this.castingMedia.pause(() => null);
              } else if (value === 2) {
                this.logDebug('Set Characteristic Media State -> ' + value);
                this.castingMedia.stop(() => null);
              }
            } catch(e) {
              this.setIsCasting('STOP', true);
              resolve();
              return;
            }

            this.setIsCasting(value === 0 ? 'PLAYING' : value === 1 ? 'PAUSED': 'STOP');
            resolve();
          }
        }));

      this.volumeService.getCharacteristic(this.platform.Characteristic.Mute) // Whether the chromecast is muted
        .onGet(() => this.muted)
        .onSet(muted => new Promise((resolve, reject) => {
          if (this.chromecastClient) {
            this.logDebug('Set Characteristic Mute -> ' + muted);
            try {
              this.chromecastClient.setVolume({ mute: muted }, () => resolve());
            } catch (e) {
              reject(new Error('Failed to set volume characteristic: ' + e as string));
            }
          }
        }));

      this.volumeService.getCharacteristic(this.platform.Characteristic.Volume) // Volume of the chromecast device
        .onGet(() => Math.floor(this.volume * 100))
        .onSet(value => new Promise((resolve, reject) => {
          if (this.chromecastClient) {
            this.logDebug('Set Characteristic Volume -> ' + value);
            try {
              this.chromecastClient.setVolume({ level: value as number / 100 }, () => resolve());
            } catch (e) {
              reject(new Error('Failed to set volume characteristic: ' + e as string));
            }
          }
        }));
    }*/

    if (this.accessory.context.config.volumeService) {
      // Create the lightbulb service for volume and play/pause control
      this.volumeService = this.accessory.getService(this.platform.Service.Lightbulb) ||
          this.accessory.addService(this.platform.Service.Lightbulb);
      this.volumeService.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

      this.volumeService.getCharacteristic(this.platform.Characteristic.On) // Whether the chromecast is streaming
        .onGet(() => this.castingStatus === 'PLAYING' || this.castingStatus === 'BUFFERING')
        .onSet(async value => new Promise(resolve => {
          if (!this.chromecastClient || !this.castingMedia || this.castingMedia.session.isIdleScreen) {
            this.setIsCasting('STOP', value as boolean);
            resolve();

          } else {
            try {
              if (value && this.castingStatus !== 'PLAYING' && this.castingStatus !== 'BUFFERING') {
                this.logDebug('Set Characteristic Casting -> ' + value);
                this.castingMedia.play(() => null);
              } else if (!value && (this.castingStatus === 'PLAYING' || this.castingStatus === 'BUFFERING')) {
                this.logDebug('Set Characteristic Casting -> ' + value);
                this.castingMedia.pause(() => null);
              }
            } catch(e) {
              this.setIsCasting('STOP', true);
              resolve();
              return;
            }

            this.setIsCasting(value as boolean ? 'PLAYING' : 'STOP');
            resolve();
          }
        }));
    }

    if (this.accessory.context.config.motionService) {
      // Create the motion sensor service for streaming status
      this.motionService = this.accessory.getService('Streaming') ||
        this.accessory.addService(this.platform.Service.MotionSensor, 'Streaming', this.accessory.UUID + '-Streaming');

      this.motionService.getCharacteristic(this.platform.Characteristic.MotionDetected) // Whether the chromecast is streaming
        .onGet(() =>this.castingStatus === 'PLAYING' || this.castingStatus === 'BUFFERING');
    }

    if (this.accessory.context.config.volumeService || this.accessory.context.config.motionService) {
      this.clientConnect();
    }
    if (this.accessory.context.config.type !== 'audio') {
      this.remoteConnect();
    }
  }

  logDebug = (s: string) => this.platform.log.debug('[' + this.accessory.displayName + ']', s);
  logInfo = (s: string) => this.platform.log.info('[' + this.accessory.displayName + ']', s);
  logError = (s: string) => this.platform.log.error('[' + this.accessory.displayName + ']', s);

  /**
   * Update the casting status of the volume and/or motion services
   * @param {boolean} status - Whether the device is streaming or not
   * @param {boolean} set - Whether to call the service set handler when updating the status
   */
  setIsCasting(status: string, set = false) {
    this.castingStatus = status;
    if (set) {
      this.volumeService?.setCharacteristic(this.platform.Characteristic.On, status === 'PLAYING' || status === 'BUFFERING');
      this.motionService?.setCharacteristic(this.platform.Characteristic.MotionDetected, status === 'PLAYING' || status === 'BUFFERING');
      this.tvService?.setCharacteristic(this.platform.Characteristic.CurrentMediaState, this.currentMediaState());
      this.tvService?.setCharacteristic(this.platform.Characteristic.TargetMediaState, this.targetMediaState());
    } else {
      this.volumeService?.updateCharacteristic(this.platform.Characteristic.On, status === 'PLAYING' || status === 'BUFFERING');
      this.motionService?.updateCharacteristic(this.platform.Characteristic.MotionDetected, status === 'PLAYING' || status === 'BUFFERING');
      this.tvService?.updateCharacteristic(this.platform.Characteristic.CurrentMediaState, this.currentMediaState());
      this.tvService?.updateCharacteristic(this.platform.Characteristic.TargetMediaState, this.targetMediaState());
    }
  }

  /**
   * Update the active status of the TV service
   * @param {boolean} status - Whether the device is powered on
   */
  setIsPowered(status: boolean) {
    this.powered = status;
    this.tvService?.updateCharacteristic(this.platform.Characteristic.Active, this.powered);
  }

  /**
   * Update the current volume of the TV service
   * @param {number} volume - The volume of the device
   * @param {boolean} muted - Whether the device is muted
   */
  setVolumeMuted(volume: number, muted: boolean) {
    this.volume = volume;
    this.muted = muted;
    this.tvSpeakerService?.updateCharacteristic(this.platform.Characteristic.Volume, Math.floor(this.volume * 100));
    this.tvSpeakerService?.updateCharacteristic(this.platform.Characteristic.Mute, this.muted);
  }

  /**
   * Update the current app of the TV service
   * @param {string} current_app - Identifier of the currently open app
   */
  setCurrentApp(current_app: string) {
    let identifier = 0;
    this.appIndex = 9999;
    for (const app of this.accessory.context.config.tvApps) {
      if (app.id === current_app) {
        this.appIndex = identifier;
        this.tvService?.updateCharacteristic(this.platform.Characteristic.ActiveIdentifier, this.appIndex);
        break;
      }
      identifier++;
    }
  }

  /**
   * Computes current media state for TV service
   * @returns {number} - TV current media state
   */
  currentMediaState(): number {
    if (this.castingStatus === 'PLAYING') {
      return this.platform.Characteristic.CurrentMediaState.PLAY;
    } else if (this.castingStatus === 'BUFFERING') {
      return this.platform.Characteristic.CurrentMediaState.LOADING;
    } else if (this.castingMedia && !this.castingMedia.session.isIdleScreen) {
      return this.platform.Characteristic.CurrentMediaState.PAUSE;
    } else {
      return this.platform.Characteristic.CurrentMediaState.STOP;
    }
  }

  /**
   * Computes target media state for TV service
   * @returns {number} - TV target media state
   */
  targetMediaState(): number {
    if (this.castingStatus === 'PLAYING' || this.castingStatus === 'BUFFERING') {
      return this.platform.Characteristic.TargetMediaState.PLAY;
    } else if (this.castingMedia && !this.castingMedia.session.isIdleScreen) {
      return this.platform.Characteristic.TargetMediaState.PAUSE;
    } else {
      return this.platform.Characteristic.TargetMediaState.STOP;
    }
  }

  /**
   * Connect to the Chromecast and establish callback handlers
   */
  clientConnect() {
    this.chromecastClient = new Client();

    const connectionDetails = {
      host: this.accessory.context.ip,
      port: this.accessory.context.port,
    };

    this.chromecastClient
      .on('status', status => this.processClientStatus(status))
      .on('timeout', () => this.logDebug('Chromecast client - timeout'))
      .on('error', status => {
        this.logError('Chromecast client - error: ' + status);
        this.clientDisconnect(true);
      });

    this.logInfo(`Connecting to Chromecast on ${this.accessory.context.ip}:${this.accessory.context.port}`);

    this.chromecastClient.connect(connectionDetails, () => {
      if (this.chromecastClient && this.chromecastClient.connection && this.chromecastClient.heartbeat && this.chromecastClient.receiver) {
        this.logInfo('Chromecast connected');
        this.reconnectCounter = 0;
        clearTimeout(this.reconnectTimer);

        this.chromecastClient.connection
          .on('timeout', () => this.logDebug('Chromecast client connection - timeout'))
          .on('disconnect', () => this.clientDisconnect(true));

        this.chromecastClient.heartbeat
          .on('timeout', () => this.logDebug('Chromecast client heartbeat - timeout'))
          .on('pong', () => null);

        this.chromecastClient.receiver
          .on('status', status => this.processClientStatus(status));

        this.chromecastClient.getStatus((_, status) => this.processClientStatus(status));
      }
    });
  }

  /**
   * Connect to the chromecast over the Android TV remote protocol and establish callback handlers
   */
  async remoteConnect() {
    this.androidRemote = new AndroidRemote(this.accessory.context.ip, {
      pairing_port: 6467,
      remote_port: 6466,
      name: 'androidtv-remote',
      cert: this.accessory.context.config.tvCert,
    });

    this.androidRemote
      .on('powered', this.setIsPowered.bind(this))
      .on('volume', volume => this.setVolumeMuted(volume.maximum === 0 ? 1 : volume.level / volume.maximum, volume.muted))
      .on('current_app', this.setCurrentApp.bind(this))
      .on('error', e => this.logError('Chromecast remote error: ' + e))
      .on('unpaired', () => this.remoteDisconnect(true))
      .on('ready', async () => {
        this.logInfo('Chromecast remote connected');
        this.remoteReconnectCounter = 0;
        clearTimeout(this.remoteReconnectTimer);
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.remoteConnected = true;
      });

    await this.androidRemote.start();
  }

  /**
   * Disconnect from the chromecast and optionally attempt reconnection
   * @param {boolean} reconnect - Whether to attempt reconnection after disconnecting
   */
  clientDisconnect(reconnect: boolean) {
    this.logDebug('Chromecast connection: disconnected');

    this.setIsCasting('STOP');
    if (this.chromecastClient) {
      try {
        this.chromecastClient.close();
      } catch (e) {
        this.logError('Chromecast disconnect error: ' + e);
      }
    } else {
      this.chromecastClient = null;
    }

    this.castingApplication = null;
    this.castingMedia = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = undefined;

    if (reconnect) {
      if (this.reconnectCounter > 150) { // Backoff after 5 minutes
        this.logError('Chromecast reconnection canceled, failed to connect to Chromecast in 5 minutes, starting rediscovery');
        this.platform.discoverDevices();
        return;
      }

      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectCounter++;
        this.clientConnect();
      }, 2000);
    }
  }

  /**
   * Disconnect from the chromecast remote and optionally attempt reconnection
   * @param {boolean} reconnect - Whether to attempt reconnection after disconnecting
   */
  remoteDisconnect(reconnect: boolean) {
    this.logDebug('Chromecast remote connection: disconnected');

    this.remoteConnected = false;
    if (this.androidRemote) {
      this.androidRemote.stop();
    } else {
      this.androidRemote = null;
    }

    this.setIsPowered(false);

    if (this.remoteReconnectTimer) {
      clearTimeout(this.remoteReconnectTimer);
    }
    this.remoteReconnectTimer = undefined;

    if (reconnect) {
      if (this.remoteReconnectCounter > 30) { // Backoff after 5 minutes
        this.logError('Chromecast remote reconnection canceled, failed to connect to Chromecast in 5 minutes, starting rediscovery');
        this.platform.discoverDevices();
        return;
      }

      clearTimeout(this.remoteReconnectTimer);
      this.remoteReconnectTimer = setTimeout(() => {
        this.remoteReconnectCounter++;
        this.remoteConnect();
      }, 10000);
    }
  }

  /**
   * Process received status from the Chromecast, and update streaming status / volume
   * @param status - The new client status
   */
  processClientStatus(status) {
    this.logDebug('Received client status: ' + status);

    const { applications } = status;
    const currentApplication = applications && applications.length > 0 ? applications[0] : null;

    if (currentApplication) {
      const lastMonitoredApplicationStatusId = this.castingApplication ? this.castingApplication.sessionId : null;

      if (currentApplication.sessionId !== lastMonitoredApplicationStatusId) {
        this.castingApplication = currentApplication;
        this.castingApplication.transportId = this.castingApplication.sessionId;

        try {
          this.chromecastClient.join(
            this.castingApplication,
            DefaultMediaReceiver,
            (_, media) => {
              this.logDebug('Chromecast status - new media');
              media.getStatus((_, mediaStatus) => this.processMediaStatus(mediaStatus));
              media.on('status', mediaStatus => this.processMediaStatus(mediaStatus));
              this.castingMedia = media;
            },
          );
        } catch (e) {
          this.logError('Chromecast status - error: ' + e);
          this.clientDisconnect(true);
        }
      }
    } else {
      this.castingMedia = null;
      this.logDebug('Chromecast status - reset media');
    }

    // Process "Stop casting" command
    if (typeof status.applications === 'undefined') {
      this.logDebug('Chromecast status - stopped casting');
      this.setIsCasting('STOP');
    }

    // Process volume
    if (status.volume && 'level' in status.volume) {
      this.setVolumeMuted(status.volume.level, status.volume.muted as boolean);
      if (this.accessory.context.config.volumeService && status.volume.controlType !== 'fixed') {
        this.volumeService?.getCharacteristic(this.platform.Characteristic.Brightness) // Volume of the chromecast device
          .onGet(() => Math.floor(this.volume * 100))
          .onSet(value => new Promise((resolve, reject) => {
            if (this.chromecastClient) {
              this.logDebug('Set Characteristic Volume -> ' + value);
              try {
                this.chromecastClient.setVolume({ level: value as number / 100 }, () => resolve());
              } catch (e) {
                reject(new Error('Failed to set volume characteristic: ' + e as string));
              }
            }
          }));
      }
    }
  }

  /**
   * Process received media status from the Chromecast, and update streaming status
   * @param status - The new media status
   */
  processMediaStatus(status) {
    this.logDebug('Received media status: ' + status);
    if (status && status.playerState) {
      this.setIsCasting(status.playerState);
    }
  }

  /**
   * Sets the chromecast power on or off
   * @param {boolean} value - Whether the chromecast should be powered on or off
   * @returns {Promise}
   */
  async setActive(value: CharacteristicValue): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.remoteConnected) {
        try {
          if (this.powered !== (value === this.platform.Characteristic.Active.ACTIVE)) {
            this.androidRemote.sendPower();
          }
          this.logDebug('Set Characteristic Active -> ' + value);
          resolve();
        } catch (e) {
          reject(e);
        }
      } else {
        reject('Chromecast remote is disconnected');
      }
    });
  }
}
