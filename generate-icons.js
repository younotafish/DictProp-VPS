import { createCanvas, loadImage } from 'canvas';
import fs from 'fs';
import path from 'path';

const ICON_PATH = 'icon.png';
const OUTPUT_DIR = 'public';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR);
}

const targets = [
  { name: 'pwa-192x192.png', size: 192 },
  { name: 'pwa-512x512.png', size: 512 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32x32.png', size: 32 },
];

async function generateIcons() {
  if (fs.existsSync(ICON_PATH)) {
    console.log(`Found ${ICON_PATH}. Generating icons from source image...`);
    
    try {
      const image = await loadImage(ICON_PATH);
      
      for (const target of targets) {
        const canvas = createCanvas(target.size, target.size);
        const ctx = canvas.getContext('2d');
        
        // Quality settings for resizing
        ctx.quality = 'best';
        ctx.patternQuality = 'best';
        ctx.antialias = 'subpixel';
        
        ctx.drawImage(image, 0, 0, target.size, target.size);
        
        const buffer = canvas.toBuffer('image/png');
        const outputPath = path.join(OUTPUT_DIR, target.name);
        fs.writeFileSync(outputPath, buffer);
        console.log(`✅ Created ${target.name}`);
      }
      
      console.log('Done! Icons saved to public/ folder');
      
    } catch (error) {
      console.error('Error processing icon.png:', error);
      process.exit(1);
    }
  } else {
    console.log(`${ICON_PATH} not found. Generating default icons (fallback)...`);
    // Fallback generation (keeping the old logic if needed, but wrapped)
    // For now, let's just create the fallback if the file is missing.
    generateFallbackIcons();
  }
}

function generateFallbackIcons() {
  // Re-implementation of the previous drawing logic if needed
  // ... (omitted for brevity, assume user has icon.png as confirmed)
  console.error("Error: icon.png not found and fallback generation is disabled to prevent ugly icons.");
  process.exit(1);
}

generateIcons();
