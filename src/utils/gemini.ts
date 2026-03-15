import { GoogleGenAI } from '@google/genai';

/**
 * Helper function to call Gemini API with exponential backoff retry logic.
 */
export async function generateContentWithRetry(ai: GoogleGenAI, params: any, maxRetries = 3) {
  let retries = 0;
  while (true) {
    try {
      return await ai.models.generateContent(params);
    } catch (error: any) {
      if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
        if (retries >= maxRetries) {
          throw error;
        }
        const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
        console.warn(`Rate limit hit. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
}

export async function generateVideosWithRetry(ai: GoogleGenAI, params: any, maxRetries = 3) {
  let retries = 0;
  while (true) {
    try {
      return await ai.models.generateVideos(params);
    } catch (error: any) {
      if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('RESOURCE_EXHAUSTED')) {
        if (retries >= maxRetries) {
          throw error;
        }
        const delay = Math.pow(2, retries) * 1000 + Math.random() * 1000;
        console.warn(`Rate limit hit for generateVideos. Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        retries++;
      } else {
        throw error;
      }
    }
  }
}
