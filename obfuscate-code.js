import JavaScriptObfuscator from 'javascript-obfuscator';
import fs from 'fs/promises';
import path from 'path';

const OBFUSCATION_CONFIG = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 1,
  numbersToExpressions: true,
  simplify: true,
  stringArrayShuffle: true,
  splitStrings: true,
  stringArray: true,
  stringArrayThreshold: 1,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: true,
  debugProtection: true,
  debugProtectionInterval: 2000,
  disableConsoleOutput: false,
  domainLock: [],
  reservedNames: [],
  seed: 0
};

const filesToObfuscate = [
  'main.js',
  'config.js', 
  'logger.js',
  'euclid-arbitrum-sepolia.js',
  'euclid-base-sepolia.js',
  'euclid-ethereum-sepolia.js',
  'euclid-linea.js',
  'euclid-megaeth.js',
  'euclid-monad.js',
  'euclid-optimism.js',
  'euclid-osmosis.js',
  'euclid-somnia.js',
  'euclid-soneium.js'
];

console.log('🔐 Starting code obfuscation process...\n');

async function obfuscateFile(filename) {
  try {
    console.log(`📄 Processing: ${filename}`);
    
    // Read the original file
    const sourceCode = await fs.readFile(filename, 'utf8');
    
    // Create backup
    await fs.writeFile(`${filename}.backup`, sourceCode);
    console.log(`   ✅ Backup created: ${filename}.backup`);
    
    // Obfuscate the code
    const obfuscated = JavaScriptObfuscator.obfuscate(sourceCode, OBFUSCATION_CONFIG);
    
    // Write obfuscated code back to original file
    await fs.writeFile(filename, obfuscated.getObfuscatedCode());
    console.log(`   🔐 Obfuscated: ${filename}`);
    console.log(`   📊 Size: ${sourceCode.length} → ${obfuscated.getObfuscatedCode().length} bytes\n`);
    
    return true;
  } catch (error) {
    console.error(`   ❌ Error obfuscating ${filename}: ${error.message}\n`);
    return false;
  }
}

async function main() {
  let successCount = 0;
  let totalFiles = filesToObfuscate.length;
  
  for (const file of filesToObfuscate) {
    try {
      await fs.access(file);
      const success = await obfuscateFile(file);
      if (success) successCount++;
    } catch (error) {
      console.log(`   ⚠️  Skipping ${file} (file not found)\n`);
    }
  }
  
  console.log('🎯 OBFUSCATION SUMMARY');
  console.log('=====================');
  console.log(`✅ Successfully obfuscated: ${successCount}/${totalFiles} files`);
  console.log(`📁 Backup files created with .backup extension`);
  console.log(`📝 README.md remains readable and unchanged`);
  console.log(`🔐 Your code is now unreadable but fully functional!`);
  
  if (successCount > 0) {
    console.log('\n🚀 NEXT STEPS:');
    console.log('==============');
    console.log('1. Test your bot: node main.js');
    console.log('2. Commit to GitHub: git add . && git commit -m "Obfuscated code"');
    console.log('3. Push to public repo: git push');
    console.log('\n✨ Your repository will be public but code unreadable!');
  }
}

main().catch(console.error);
