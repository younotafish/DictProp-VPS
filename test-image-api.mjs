/**
 * Test script for Replicate image generation API
 * Run with: node test-image-api.mjs
 */

import { initializeApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";

// Firebase config (same as in firebase.ts)
const config = {
  apiKey: "AIzaSyA0JgY0hTlnXZSVg3WQGfKhVm7ij0sTy-s",
  authDomain: "dictpropstore.firebaseapp.com",
  projectId: "dictpropstore",
  storageBucket: "dictpropstore.firebasestorage.app",
  messagingSenderId: "340564794762",
  appId: "1:340564794762:web:23e2bb5a14c9f8c8d43c73"
};

const app = initializeApp(config);
const functions = getFunctions(app, 'us-central1');

async function testImageGeneration() {
  console.log("🧪 Testing image generation API...\n");
  
  const generateIllustrationFn = httpsCallable(functions, 'generateIllustration');
  
  const testPrompts = [
    "a simple red apple",
    "a blue cat sitting",
    "a yellow star"
  ];
  
  for (const prompt of testPrompts) {
    console.log(`📝 Testing prompt: "${prompt}"`);
    const startTime = Date.now();
    
    try {
      const result = await generateIllustrationFn({ prompt, aspectRatio: '1:1' });
      const data = result.data;
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      
      if (data.error === "QUOTA_EXCEEDED") {
        console.log(`⚠️  RATE LIMITED / QUOTA EXCEEDED (${elapsed}s)`);
        console.log("   The API has hit its usage limit.\n");
      } else if (data.imageData) {
        const sizeKB = Math.round(data.imageData.length * 0.75 / 1024);
        console.log(`✅ SUCCESS! Image generated (${sizeKB}KB, ${elapsed}s)`);
        console.log(`   Data URL preview: ${data.imageData.substring(0, 50)}...\n`);
      } else {
        console.log(`❓ Unexpected response (${elapsed}s):`, data, "\n");
      }
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      console.log(`❌ ERROR (${elapsed}s):`, error.message);
      console.log("   Code:", error.code);
      console.log("   Details:", JSON.stringify(error.details || {}, null, 2));
      console.log("   Full error:", JSON.stringify(error, null, 2));
      
      if (error.code === 'functions/resource-exhausted' || 
          error.message.includes('QUOTA') ||
          error.message.includes('429') ||
          error.message.includes('402')) {
        console.log("   ⚠️  This appears to be a rate limit / quota issue.\n");
      } else {
        console.log("");
      }
    }
    
    // Small delay between requests
    await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log("🏁 Test complete!");
}

testImageGeneration().catch(console.error);

