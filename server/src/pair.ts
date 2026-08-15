import { Store } from './db.js';
import { generatePairingCode } from './pairing.js';

const store = new Store();
const code = generatePairingCode(store);
console.log(`Pairing code: ${code} (valid for 10 minutes)`);
store.close();
