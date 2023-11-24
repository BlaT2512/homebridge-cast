import mdns from 'mdns';
import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic, Categories } from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { ChromecastPlatformAccessory } from './platformAccessory';

/**
 * Chromecast Homebridge Platform
 * Parses the user config and discovers/registers Chromecast accessories with Homebridge
 */
export class ChromecastHomebridgePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;
  public readonly accessories: PlatformAccessory[] = [];
  private accessoryInstances: ChromecastPlatformAccessory[] = [];
  private browser: mdns.Browser = mdns.createBrowser(mdns.tcp('googlecast'), { resolverSequence: [
    mdns.rst.DNSServiceResolve(),
    'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({ families: [0] }),
    mdns.rst.makeAddressesUnique(),
  ]});

  constructor (
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      // Discover / register devices as accessories
      if (this.config.devices.length > 0) {
        this.discoverDevices();
      }
    });
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);

    // add the restored accessory to the accessories cache so we can track if it has already been registered
    this.accessories.push(accessory);
  }

  /**
   * Start mdns browser to discover and match Chromecast devices against config, then register them as accessories
   */
  discoverDevices() {
    this.accessoryInstances = [];
    this.browser.on('serviceUp', service => {
      for (const device of this.config.devices) {
        const ip = service.addresses.find(address => (address.match(/\./g) || []).length === 3);
        if (service.txtRecord.fn.toLowerCase() === device.name.toLowerCase() || ip === device.name) {
          // Check if it already exists
          const uuid = this.api.hap.uuid.generate(service.txtRecord.id + (device.type === 'audio' ? '' : '-tv'));
          const existingAccessory = this.accessories.find(accessory => accessory.UUID === uuid);
          this.log.info('Found matching chromecast accessory:', device.displayName || device.name);
          const accessory = existingAccessory || new this.api.platformAccessory(device.displayName || device.name, uuid);

          // Store connection details in the accessory context
          accessory.context.config = device;
          accessory.context.ip = ip;
          accessory.context.port = service.port;
          accessory.context.model = service.txtRecord.md;
          accessory.category = device.type === 'tv' ? Categories.TELEVISION : device.type === 'streamstick' ?
            Categories.TV_STREAMING_STICK : device.volumeService ? Categories.LIGHTBULB : Categories.SENSOR;
          if (existingAccessory) {
            this.api.updatePlatformAccessories([accessory]);
          }

          // Create accessory handler and publish accessory
          this.accessoryInstances.push(new ChromecastPlatformAccessory(this, accessory));
          if (!existingAccessory && device.type === 'audio') {
            this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          } else if (!existingAccessory) {
            this.api.publishExternalAccessories(PLUGIN_NAME, [accessory]);
          }
        }
      }
    });

    this.browser.start();

    // Restart browser every 30 minutes to refresh devices
    //setTimeout(this.restartBrowser.bind(this), 30 * 60 * 1000);
  }

  /**
   * Restart mdns browser to refresh all accessories
   */
  restartBrowser() {
    this.browser.stop();
    this.log.debug('Restarting chromecast browser');
    this.discoverDevices();
  }
}
