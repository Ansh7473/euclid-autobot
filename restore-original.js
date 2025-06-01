import fs from 'fs/promises';

const backupFiles = [
  'main.js.backup',
  'config.js.backup',
  'logger.js.backup',
  'euclid-arbitrum-sepolia.js.backup',
  'euclid-base-sepolia.js.backup',
  'euclid-ethereum-sepolia.js.backup',
  'euclid-linea.js.backup',
  'euclid-megaeth.js.backup',
  'euclid-monad.js.backup',
  'euclid-optimism.js.backup',
  'euclid-osmosis.js.backup',
  'euclid-somnia.js.backup',
  'euclid-soneium.js.backup'
];

console.log('🔄 RESTORING ORIGINAL CODE FROM BACKUPS');
console.log('=======================================\n');

let restoredCount = 0;

for (const backupFile of backupFiles) {
  const originalFile = backupFile.replace('.backup', '');
  
  try {
    await fs.access(backupFile);
    const backupContent = await fs.readFile(backupFile, 'utf8');
    await fs.writeFile(originalFile, backupContent);
    console.log(`✅ Restored: ${originalFile}`);
    restoredCount++;
  } catch (error) {
    console.log(`⚠️  Skipping ${backupFile} (not found)`);
  }
}

console.log(`\n🎯 RESTORE SUMMARY`);
console.log(`==================`);
console.log(`✅ Restored ${restoredCount} files from backups`);
console.log(`📝 Your original readable code is back!`);
