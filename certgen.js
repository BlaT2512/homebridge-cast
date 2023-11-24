const mdns = require('mdns');
const { AndroidRemote } = require('androidtv-remote');
const Readline = require('readline');

let browser = mdns.createBrowser(mdns.tcp('googlecast'), { resolverSequence: [
  mdns.rst.DNSServiceResolve(),
  'DNSServiceGetAddrInfo' in mdns.dns_sd ? mdns.rst.DNSServiceGetAddrInfo() : mdns.rst.getaddrinfo({ families: [0] }),
  mdns.rst.makeAddressesUnique(),
]});
let line = Readline.createInterface({ input: process.stdin, output: process.stdout });

async function generateCert(ip) {
  let options = {
    pairing_port: 6467,
    remote_port: 6466,
    name: 'androidtv-remote',
  };

  let androidRemote = new AndroidRemote(ip, options);

  androidRemote.on('secret', () => {
    line.question('Enter code displayed on screen : ', async (code) => {
      androidRemote.sendCode(code);
    });
  });

  androidRemote.on('error', error => {
    console.error('Warning - Error Encountered :', error);
  });

  androidRemote.on('unpaired', () => {
    console.error('Warning - Device Disconnected');
  });

  androidRemote.on('ready', async () => {
    console.log('Code successful, pending certificate...');
    await new Promise(resolve => setTimeout(resolve, 2000));

    let cert = androidRemote.getCertificate();

    console.log('Certificate:');
    console.log('');
    console.log(cert);
    console.log('');
    console.log('Paste the above certificate in the config for this accessory as \'tvCert\' property');
    process.exit();
  });

  await androidRemote.start();
}

console.log('Ensure your device is turned on and you can see the display');
line.question('Device Name (copy from config) : ', name => {
  console.log('Searching for device...');
  browser.on('serviceUp', service => {
    if (service.txtRecord.fn.toLowerCase() === name.toLowerCase()) {
      generateCert(service.addresses.find(address => (address.match(/\./g) || []).length === 3));
    }
  });
  browser.start();
});
