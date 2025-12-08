const { createCanvas } = require('canvas');
const fs = require('fs');

const sizes = [192, 512];

sizes.forEach(size => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  
  const s = size; // shorthand
  const cx = s / 2;
  const cy = s / 2;
  
  // Background gradient (deep violet to indigo)
  const bgGradient = ctx.createLinearGradient(0, 0, s, s);
  bgGradient.addColorStop(0, '#7c3aed');  // violet-600
  bgGradient.addColorStop(0.5, '#6366f1'); // indigo-500
  bgGradient.addColorStop(1, '#4f46e5');  // indigo-600
  ctx.fillStyle = bgGradient;
  
  // Rounded rectangle background
  const radius = s * 0.22;
  ctx.beginPath();
  ctx.roundRect(0, 0, s, s, radius);
  ctx.fill();
  
  // Subtle inner glow
  const innerGlow = ctx.createRadialGradient(cx, cy * 0.8, 0, cx, cy, s * 0.6);
  innerGlow.addColorStop(0, 'rgba(255, 255, 255, 0.15)');
  innerGlow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = innerGlow;
  ctx.beginPath();
  ctx.roundRect(0, 0, s, s, radius);
  ctx.fill();
  
  // === OPEN BOOK ICON ===
  const bookWidth = s * 0.52;
  const bookHeight = s * 0.38;
  const bookX = cx - bookWidth / 2;
  const bookY = cy - bookHeight / 2 + s * 0.02;
  
  ctx.save();
  
  // Left page (with subtle curve)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.beginPath();
  ctx.moveTo(cx, bookY);
  ctx.lineTo(cx, bookY + bookHeight);
  ctx.lineTo(bookX, bookY + bookHeight);
  ctx.quadraticCurveTo(bookX - s * 0.02, bookY + bookHeight * 0.5, bookX, bookY);
  ctx.closePath();
  ctx.fill();
  
  // Right page (with subtle curve)
  ctx.beginPath();
  ctx.moveTo(cx, bookY);
  ctx.lineTo(cx, bookY + bookHeight);
  ctx.lineTo(bookX + bookWidth, bookY + bookHeight);
  ctx.quadraticCurveTo(bookX + bookWidth + s * 0.02, bookY + bookHeight * 0.5, bookX + bookWidth, bookY);
  ctx.closePath();
  ctx.fill();
  
  // Book spine shadow (center line)
  ctx.strokeStyle = 'rgba(99, 102, 241, 0.3)';
  ctx.lineWidth = s * 0.012;
  ctx.beginPath();
  ctx.moveTo(cx, bookY);
  ctx.lineTo(cx, bookY + bookHeight);
  ctx.stroke();
  
  // Text lines on left page
  ctx.fillStyle = 'rgba(99, 102, 241, 0.4)';
  const lineHeight = s * 0.035;
  const lineGap = s * 0.055;
  const leftLineX = bookX + s * 0.04;
  const lineStartY = bookY + s * 0.06;
  
  for (let i = 0; i < 4; i++) {
    const lineWidth = (i % 2 === 0) ? s * 0.16 : s * 0.12;
    ctx.beginPath();
    ctx.roundRect(leftLineX, lineStartY + i * lineGap, lineWidth, lineHeight, lineHeight / 2);
    ctx.fill();
  }
  
  // Text lines on right page
  const rightLineX = cx + s * 0.04;
  for (let i = 0; i < 4; i++) {
    const lineWidth = (i % 2 === 0) ? s * 0.14 : s * 0.17;
    ctx.beginPath();
    ctx.roundRect(rightLineX, lineStartY + i * lineGap, lineWidth, lineHeight, lineHeight / 2);
    ctx.fill();
  }
  
  ctx.restore();
  
  // === SPARKLES (AI magic) ===
  const drawSparkle = (x, y, size, opacity = 1) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
    
    // 4-point star sparkle
    ctx.beginPath();
    const outer = size;
    const inner = size * 0.3;
    for (let i = 0; i < 8; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const angle = (i * Math.PI) / 4 - Math.PI / 2;
      if (i === 0) {
        ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
      } else {
        ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
      }
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  
  // Main sparkle (top right)
  drawSparkle(cx + s * 0.28, cy - s * 0.22, s * 0.07, 1);
  
  // Smaller sparkles
  drawSparkle(cx + s * 0.35, cy - s * 0.08, s * 0.035, 0.8);
  drawSparkle(cx - s * 0.32, cy - s * 0.28, s * 0.04, 0.7);
  drawSparkle(cx + s * 0.18, cy - s * 0.32, s * 0.03, 0.6);
  
  // === Small dots for extra magic ===
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  const dots = [
    [cx - s * 0.25, cy - s * 0.18, s * 0.012],
    [cx + s * 0.38, cy + s * 0.05, s * 0.01],
    [cx - s * 0.35, cy + s * 0.12, s * 0.008],
  ];
  dots.forEach(([dx, dy, dr]) => {
    ctx.beginPath();
    ctx.arc(dx, dy, dr, 0, Math.PI * 2);
    ctx.fill();
  });
  
  // Save
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(`public/pwa-${size}x${size}.png`, buffer);
  console.log(`✅ Created pwa-${size}x${size}.png`);
});

console.log('Done! Icons saved to public/ folder');
