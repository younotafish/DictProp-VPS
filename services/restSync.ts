
import { StoredItem } from "../types";
import { mergeDatasets } from "./sync";

/**
 * Syncs local data with a custom REST API.
 * 
 * Protocol:
 * 1. GET {url} -> Returns StoredItem[]
 * 2. Merge with local
 * 3. POST {url} body: StoredItem[] -> Saves data
 * 
 * Auth:
 * If apiKey is provided, adds 'Authorization: Bearer {apiKey}' header.
 */
export const syncWithCustomServer = async (
  url: string, 
  apiKey: string | undefined, 
  localItems: StoredItem[]
): Promise<{ items: StoredItem[], hasChanges: boolean }> => {
  
  if (!url) throw new Error("Server URL is missing");

  const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
  };

  if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
  }

  try {
    // 1. PULL
    console.log("🔄 Custom Sync: Pulling from", url);
    const response = await fetch(url, { method: 'GET', headers });
    
    if (!response.ok) {
        throw new Error(`Server returned ${response.status}: ${response.statusText}`);
    }

    const remoteItems: StoredItem[] = await response.json();
    
    if (!Array.isArray(remoteItems)) {
        throw new Error("Server response was not an array");
    }

    // 2. MERGE
    const mergedItems = mergeDatasets(localItems, remoteItems);
    
    // Check if we actually have new data/changes compared to what we started with
    // AND if the merged data is different from what the server gave us (meaning we have local updates to push)
    const localChanged = JSON.stringify(mergedItems) !== JSON.stringify(localItems);
    const serverNeedsUpdate = JSON.stringify(mergedItems) !== JSON.stringify(remoteItems);

    // 3. PUSH (Only if needed)
    if (serverNeedsUpdate) {
        console.log("🔄 Custom Sync: Pushing updates...");
        const pushResponse = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(mergedItems)
        });
        
        if (!pushResponse.ok) {
            throw new Error(`Failed to push updates: ${pushResponse.status}`);
        }
    }

    return { items: mergedItems, hasChanges: localChanged };

  } catch (error) {
    console.error("Custom Sync Error:", error);
    throw error;
  }
};
