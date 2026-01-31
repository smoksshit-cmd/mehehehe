/**
 * Inline Image Generation Extension for SillyTavern
 * 
 * Catches [IMG:GEN:{json}] tags in AI messages and generates images via configured API.
 * Supports OpenAI-compatible and Gemini-compatible (nano-banana) endpoints.
 */

const MODULE_NAME = 'inline_image_gen';

// Track messages currently being processed to prevent duplicate processing
const processingMessages = new Set();

// Log buffer for debugging
const logBuffer = [];
const MAX_LOG_ENTRIES = 200;

function iigLog(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const entry = `[${timestamp}] [${level}] ${message}`;
    
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG_ENTRIES) {
        logBuffer.shift();
    }
    
    if (level === 'ERROR') {
        console.error('[IIG]', ...args);
    } else if (level === 'WARN') {
        console.warn('[IIG]', ...args);
    } else {
        console.log('[IIG]', ...args);
    }
}

function exportLogs() {
    const logsText = logBuffer.join('\n');
    const blob = new Blob([logsText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `iig-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toastr.success('Логи экспортированы', 'Генерация картинок');
}

// Default settings
const defaultSettings = Object.freeze({
    enabled: true,
    apiType: 'openai', // 'openai' or 'gemini'
    endpoint: '',
    apiKey: '',
    model: '',
    size: '1024x1024',
    quality: 'standard',
    maxRetries: 0, // No auto-retry - user clicks error image to retry manually
    retryDelay: 1000,
    // Nano-banana specific
    sendCharAvatar: false,
    sendUserAvatar: false,
    userAvatarFile: '', // Selected user avatar filename from /User Avatars/
    aspectRatio: '1:1', // "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"
    imageSize: '1K', // "1K", "2K", "4K"
    // NEW: Custom prompts (prepended to generation)
    positivePrompt: '', // Added BEFORE character description
    negativePrompt: '', // Added as negative instruction
    // NEW: Fixed style (persists across generations)
    fixedStyle: '', // e.g. "Avatar movie style", "Anime style", "Cyberpunk game style"
    fixedStyleEnabled: false,
    // NEW: Character appearance extraction
    extractAppearance: true, // Extract appearance from character card description
    extractUserAppearance: true, // Extract appearance from user persona
    // NEW: Clothing detection from chat
    detectClothing: true, // Detect clothing mentions in recent messages
    clothingSearchDepth: 5, // How many messages back to search for clothing
});

// Image model detection keywords (from your api_client.py)
const IMAGE_MODEL_KEYWORDS = [
    'dall-e', 'midjourney', 'mj', 'journey', 'stable-diffusion', 'sdxl', 'flux',
    'imagen', 'drawing', 'paint', 'image', 'seedream', 'hidream', 'dreamshaper',
    'ideogram', 'nano-banana', 'gpt-image', 'wanx', 'qwen'
];

// Video model keywords to exclude
const VIDEO_MODEL_KEYWORDS = [
    'sora', 'kling', 'jimeng', 'veo', 'pika', 'runway', 'luma',
    'video', 'gen-3', 'minimax', 'cogvideo', 'mochi', 'seedance',
    'vidu', 'wan-ai', 'hunyuan', 'hailuo'
];

// We'll parse tags manually since JSON can contain nested braces
// Tag format: [IMG:GEN:{...json...}] or <img src="[IMG:GEN:{...json...}]">

/**
 * Check if model ID is an image generation model
 */
function isImageModel(modelId) {
    const mid = modelId.toLowerCase();
    
    // Exclude video models
    for (const kw of VIDEO_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return false;
    }
    
    // Exclude vision models
    if (mid.includes('vision') && mid.includes('preview')) return false;
    
    // Check for image model keywords
    for (const kw of IMAGE_MODEL_KEYWORDS) {
        if (mid.includes(kw)) return true;
    }
    
    return false;
}

/**
 * Check if model is Gemini/nano-banana type
 */
function isGeminiModel(modelId) {
    const mid = modelId.toLowerCase();
    return mid.includes('nano-banana');
}

/**
 * Get extension settings
 */
function getSettings() {
    const context = SillyTavern.getContext();
    
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    
    // Ensure all default keys exist
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(context.extensionSettings[MODULE_NAME], key)) {
            context.extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    
    return context.extensionSettings[MODULE_NAME];
}

/**
 * Save settings - forces immediate save for reliability
 */
function saveSettings() {
    const context = SillyTavern.getContext();
    // Use debounced for normal operation
    context.saveSettingsDebounced();
    // Also log current state for debugging
    const settings = context.extensionSettings[MODULE_NAME];
    iigLog('INFO', `Settings saved. Current state: fixedStyle="${settings?.fixedStyle || ''}", positive="${(settings?.positivePrompt || '').substring(0,20)}", negative="${(settings?.negativePrompt || '').substring(0,20)}"`);
}

/**
 * Fetch models list from endpoint
 */
async function fetchModels() {
    const settings = getSettings();
    
    if (!settings.endpoint || !settings.apiKey) {
        console.warn('[IIG] Cannot fetch models: endpoint or API key not set');
        return [];
    }
    
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/models`;
    
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        const data = await response.json();
        const models = data.data || [];
        
        // Filter for image models only
        return models.filter(m => isImageModel(m.id)).map(m => m.id);
    } catch (error) {
        console.error('[IIG] Failed to fetch models:', error);
        toastr.error(`Ошибка загрузки моделей: ${error.message}`, 'Генерация картинок');
        return [];
    }
}

/**
 * Fetch list of user avatars from /User Avatars/ directory
 */
async function fetchUserAvatars() {
    try {
        const context = SillyTavern.getContext();
        const response = await fetch('/api/avatars/get', {
            method: 'POST',
            headers: context.getRequestHeaders(),
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        
        return await response.json(); // Returns array of filenames
    } catch (error) {
        console.error('[IIG] Failed to fetch user avatars:', error);
        return [];
    }
}

/**
 * Convert image URL to base64
 */
async function imageUrlToBase64(url) {
    try {
        const response = await fetch(url);
        const blob = await response.blob();
        
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                // Remove data URL prefix to get pure base64
                const base64 = reader.result.split(',')[1];
                resolve(base64);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (error) {
        console.error('[IIG] Failed to convert image to base64:', error);
        return null;
    }
}

/**
 * Save base64 image to file via SillyTavern API
 * @param {string} dataUrl - Data URL (data:image/png;base64,...)
 * @returns {Promise<string>} - Relative path to saved file
 */
async function saveImageToFile(dataUrl) {
    const context = SillyTavern.getContext();
    
    // Extract base64 and format from data URL
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid data URL format');
    }
    
    const format = match[1]; // png, jpeg, webp
    const base64Data = match[2];
    
    // Get character name for subfolder
    let charName = 'generated';
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        charName = context.characters[context.characterId].name || 'generated';
    }
    
    // Generate unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `iig_${timestamp}`;
    
    const response = await fetch('/api/images/upload', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify({
            image: base64Data,
            format: format,
            ch_name: charName,
            filename: filename
        })
    });
    
    if (!response.ok) {
        const error = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
    }
    
    const result = await response.json();
    console.log('[IIG] Image saved to:', result.path);
    return result.path;
}

/**
 * Get character avatar as base64
 */
async function getCharacterAvatarBase64() {
    try {
        const context = SillyTavern.getContext();
        
        console.log('[IIG] Getting character avatar, characterId:', context.characterId);
        
        if (context.characterId === undefined || context.characterId === null) {
            console.log('[IIG] No character selected');
            return null;
        }
        
        // Try context method first
        if (typeof context.getCharacterAvatar === 'function') {
            const avatarUrl = context.getCharacterAvatar(context.characterId);
            console.log('[IIG] getCharacterAvatar returned:', avatarUrl);
            if (avatarUrl) {
                return await imageUrlToBase64(avatarUrl);
            }
        }
        
        // Fallback: try to get from characters array
        const character = context.characters?.[context.characterId];
        console.log('[IIG] Character from array:', character?.name, 'avatar:', character?.avatar);
        if (character?.avatar) {
            const avatarUrl = `/characters/${encodeURIComponent(character.avatar)}`;
            console.log('[IIG] Found character avatar:', avatarUrl);
            return await imageUrlToBase64(avatarUrl);
        }
        
        console.log('[IIG] Could not get character avatar');
        return null;
    } catch (error) {
        console.error('[IIG] Error getting character avatar:', error);
        return null;
    }
}

/**
 * Get user avatar as base64 (full resolution, not thumbnail)
 */
async function getUserAvatarBase64() {
    try {
        const settings = getSettings();
        
        // Use selected avatar from settings (user's choice)
        if (!settings.userAvatarFile) {
            console.log('[IIG] No user avatar selected in settings');
            return null;
        }
        
        const avatarUrl = `/User Avatars/${encodeURIComponent(settings.userAvatarFile)}`;
        console.log('[IIG] Using selected user avatar:', avatarUrl);
        return await imageUrlToBase64(avatarUrl);
    } catch (error) {
        console.error('[IIG] Error getting user avatar:', error);
        return null;
    }
}

/**
 * Extract character appearance from description
 * Parses character card description for physical appearance details
 */
function extractCharacterAppearance() {
    try {
        const context = SillyTavern.getContext();
        
        if (context.characterId === undefined || context.characterId === null) {
            return null;
        }
        
        const character = context.characters?.[context.characterId];
        if (!character?.description) {
            return null;
        }
        
        const description = character.description;
        const charName = character.name || 'Character';
        
        // Common appearance keywords to look for
        const appearancePatterns = [
            // Hair
            /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
            /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi,
            // Eyes  
            /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi,
            // Skin
            /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
            // Height/Build
            /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
            /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
            // Age appearance
            /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
            /(\d+)\s*(?:years?\s*old|лет|года?)/gi,
            // Features
            /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
            // Face
            /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi,
            // Body parts and features
            /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
        ];
        
        const foundTraits = [];
        const seenTexts = new Set();
        
        for (const pattern of appearancePatterns) {
            const matches = description.matchAll(pattern);
            for (const match of matches) {
                const trait = (match[1] || match[0]).trim();
                const lowerTrait = trait.toLowerCase();
                // Skip duplicates and very short matches
                if (trait.length > 2 && !seenTexts.has(lowerTrait)) {
                    seenTexts.add(lowerTrait);
                    foundTraits.push(trait);
                }
            }
        }
        
        // Also try to find structured appearance blocks
        const appearanceBlockPatterns = [
            /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
            /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
        ];
        
        for (const pattern of appearanceBlockPatterns) {
            const matches = description.matchAll(pattern);
            for (const match of matches) {
                const block = match[1].trim();
                if (block.length > 10 && !seenTexts.has(block.toLowerCase())) {
                    seenTexts.add(block.toLowerCase());
                    foundTraits.push(block);
                }
            }
        }
        
        if (foundTraits.length === 0) {
            return null;
        }
        
        // Combine into appearance description
        const appearanceText = `${charName}'s appearance: ${foundTraits.join(', ')}`;
        iigLog('INFO', `Extracted appearance: ${appearanceText.substring(0, 200)}`);
        
        return appearanceText;
    } catch (error) {
        iigLog('ERROR', 'Error extracting character appearance:', error);
        return null;
    }
}

/**
 * Extract user appearance from persona description
 * Parses user persona for physical appearance details (same logic as character)
 */
function extractUserAppearance() {
    try {
        const context = SillyTavern.getContext();
        const userName = context.name1 || 'User';
        
        // Try to get persona description from power_user
        let personaDescription = null;
        
        if (typeof window.power_user !== 'undefined' && window.power_user.persona_description) {
            personaDescription = window.power_user.persona_description;
        }
        
        if (!personaDescription) {
            return null;
        }
        
        // Common appearance keywords to look for (same as character extraction)
        const appearancePatterns = [
            // Hair
            /(?:hair|волосы)[:\s]*([^.;,\n]{3,80})/gi,
            /(?:has|have|with|имеет|с)\s+([a-zA-Zа-яА-Я\s]+(?:hair|волос[ыа]?))/gi,
            /([a-zA-Zа-яА-Я\-]+(?:\s+[a-zA-Zа-яА-Я\-]+)?)\s+hair/gi,
            // Eyes  
            /(?:eyes?|глаза?)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+eyes?/gi,
            // Skin
            /(?:skin|кожа)[:\s]*([^.;,\n]{3,60})/gi,
            /([a-zA-Zа-яА-Я\-]+)\s+skin/gi,
            // Height/Build
            /(?:height|рост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tall|short|average|высок|низк|средн)[a-zA-Zа-яА-Я]*/gi,
            /(?:build|телосложени)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:muscular|slim|athletic|thin|chubby|мускулист|стройн|худ|полн)[a-zA-Zа-яА-Я]*/gi,
            // Age appearance
            /(?:looks?|appears?|выгляд)[a-zA-Zа-яА-Я]*\s+(?:like\s+)?(?:a\s+)?(\d+|young|old|teen|adult|молод|стар|подрост|взросл)/gi,
            /(\d+)\s*(?:years?\s*old|лет|года?)/gi,
            // Features
            /(?:features?|черты)[:\s]*([^.;,\n]{3,80})/gi,
            // Face
            /(?:face|лицо)[:\s]*([^.;,\n]{3,60})/gi,
            // Body parts and features
            /(?:ears?|уши|ушки)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:tail|хвост)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:horns?|рога?)[:\s]*([^.;,\n]{3,40})/gi,
            /(?:wings?|крыль[яи])[:\s]*([^.;,\n]{3,40})/gi,
        ];
        
        const foundTraits = [];
        const seenTexts = new Set();
        
        for (const pattern of appearancePatterns) {
            const matches = personaDescription.matchAll(pattern);
            for (const match of matches) {
                const trait = (match[1] || match[0]).trim();
                const lowerTrait = trait.toLowerCase();
                // Skip duplicates and very short matches
                if (trait.length > 2 && !seenTexts.has(lowerTrait)) {
                    seenTexts.add(lowerTrait);
                    foundTraits.push(trait);
                }
            }
        }
        
        // Also try to find structured appearance blocks
        const appearanceBlockPatterns = [
            /\[?(?:appearance|внешность|looks?)\]?[:\s]*([^[\]]{10,500})/gi,
            /\[?(?:physical\s*description|физическое?\s*описание)\]?[:\s]*([^[\]]{10,500})/gi,
        ];
        
        for (const pattern of appearanceBlockPatterns) {
            const matches = personaDescription.matchAll(pattern);
            for (const match of matches) {
                const block = match[1].trim();
                if (block.length > 10 && !seenTexts.has(block.toLowerCase())) {
                    seenTexts.add(block.toLowerCase());
                    foundTraits.push(block);
                }
            }
        }
        
        if (foundTraits.length === 0) {
            // If no specific traits found, use the whole persona as fallback (if short enough)
            if (personaDescription.length < 500) {
                iigLog('INFO', `No specific user traits found, using full persona`);
                return `${userName}'s appearance: ${personaDescription}`;
            }
            return null;
        }
        
        // Combine into appearance description
        const appearanceText = `${userName}'s appearance: ${foundTraits.join(', ')}`;
        iigLog('INFO', `Extracted user appearance: ${appearanceText.substring(0, 200)}`);
        
        return appearanceText;
    } catch (error) {
        iigLog('ERROR', 'Error extracting user appearance:', error);
        return null;
    }
}

/**
 * Detect clothing from recent chat messages
 * Searches for clothing descriptions and what characters are wearing
 */
function detectClothingFromChat(depth = 5) {
    try {
        const context = SillyTavern.getContext();
        const chat = context.chat;
        
        if (!chat || chat.length === 0) {
            return null;
        }
        
        const charName = context.characters?.[context.characterId]?.name || 'Character';
        const userName = context.name1 || 'User';
        
        // Clothing-related patterns
        const clothingPatterns = [
            // English
            /(?:wearing|wears?|dressed\s+in|clothed\s+in|puts?\s+on|changed?\s+into)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:outfit|clothes|clothing|attire|garment|dress|costume)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:shirt|blouse|top|jacket|coat|sweater|hoodie|t-shirt|tank\s*top)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:pants|jeans|shorts|skirt|trousers|leggings)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:dress|gown|robe|uniform|suit|armor|armour)[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:a|an|the|his|her|their|my)\s+([\w\s\-]+(?:dress|shirt|jacket|coat|pants|jeans|skirt|blouse|sweater|hoodie|uniform|suit|armor|robe|gown|outfit|costume|clothes))/gi,
            // Russian
            /(?:одет[аоы]?|носит|оделс?я?|переодел[аи]?сь?)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:одежда|наряд|костюм|форма)[:\s]+([^.;!?\n]{5,150})/gi,
            /(?:рубашк|блузк|куртк|пальто|свитер|худи|футболк|майк)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:брюк|джинс|шорт|юбк|штан|леггинс)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
            /(?:платье|халат|мантия|униформа|доспех)[а-яА-Я]*[:\s]*([^.;!?\n]{3,100})/gi,
        ];
        
        const foundClothing = [];
        const seenTexts = new Set();
        const startIndex = Math.max(0, chat.length - depth);
        
        for (let i = chat.length - 1; i >= startIndex; i--) {
            const message = chat[i];
            if (!message.mes) continue;
            
            const text = message.mes;
            const speaker = message.is_user ? userName : charName;
            
            for (const pattern of clothingPatterns) {
                pattern.lastIndex = 0; // Reset regex
                const matches = text.matchAll(pattern);
                for (const match of matches) {
                    const clothing = (match[1] || match[0]).trim();
                    const lowerClothing = clothing.toLowerCase();
                    
                    if (clothing.length > 3 && !seenTexts.has(lowerClothing)) {
                        seenTexts.add(lowerClothing);
                        foundClothing.push({
                            text: clothing,
                            speaker: speaker,
                            messageIndex: i
                        });
                    }
                }
            }
        }
        
        if (foundClothing.length === 0) {
            return null;
        }
        
        // Build clothing description, prioritizing most recent
        const charClothing = foundClothing.filter(c => c.speaker === charName).map(c => c.text);
        const userClothing = foundClothing.filter(c => c.speaker === userName).map(c => c.text);
        
        let clothingText = '';
        if (charClothing.length > 0) {
            clothingText += `${charName} is wearing: ${charClothing.slice(0, 3).join(', ')}. `;
        }
        if (userClothing.length > 0) {
            clothingText += `${userName} is wearing: ${userClothing.slice(0, 3).join(', ')}.`;
        }
        
        iigLog('INFO', `Detected clothing: ${clothingText.substring(0, 200)}`);
        return clothingText.trim();
    } catch (error) {
        iigLog('ERROR', 'Error detecting clothing:', error);
        return null;
    }
}

/**
 * Build enhanced prompt with all context
 * IMPORTANT: Always reads fresh settings to ensure latest values are used
 */
function buildEnhancedPrompt(basePrompt, style, options = {}) {
    // CRITICAL: Get fresh settings every time, not cached
    const context = SillyTavern.getContext();
    const settings = context.extensionSettings[MODULE_NAME] || {};
    
    // Debug log current settings state
    iigLog('INFO', `buildEnhancedPrompt called. Settings state:`);
    iigLog('INFO', `  - fixedStyleEnabled: ${settings.fixedStyleEnabled}`);
    iigLog('INFO', `  - fixedStyle: "${settings.fixedStyle || ''}"`);
    iigLog('INFO', `  - positivePrompt: "${(settings.positivePrompt || '').substring(0, 30)}..."`);
    iigLog('INFO', `  - negativePrompt: "${(settings.negativePrompt || '').substring(0, 30)}..."`);
    iigLog('INFO', `  - extractAppearance: ${settings.extractAppearance}`);
    iigLog('INFO', `  - detectClothing: ${settings.detectClothing}`);
    
    const promptParts = [];
    
    // 1. Fixed style (highest priority - at the very beginning)
    if (settings.fixedStyleEnabled === true && settings.fixedStyle && settings.fixedStyle.trim() !== '') {
        promptParts.push(`[STYLE: ${settings.fixedStyle.trim()}]`);
        iigLog('INFO', `✓ Applied fixed style: ${settings.fixedStyle}`);
    } else {
        iigLog('INFO', `✗ Fixed style NOT applied (enabled=${settings.fixedStyleEnabled}, style="${settings.fixedStyle || ''}")`);
    }
    
    // 2. Positive prompt from settings (before character description)
    if (settings.positivePrompt && settings.positivePrompt.trim() !== '') {
        promptParts.push(settings.positivePrompt.trim());
        iigLog('INFO', `✓ Applied positive prompt: ${settings.positivePrompt.substring(0, 50)}`);
    } else {
        iigLog('INFO', `✗ Positive prompt NOT applied (value="${settings.positivePrompt || ''}")`);
    }
    
    // 3. Style from tag (if not using fixed style)
    if (style && !(settings.fixedStyleEnabled === true && settings.fixedStyle && settings.fixedStyle.trim() !== '')) {
        promptParts.push(`[Style: ${style}]`);
        iigLog('INFO', `✓ Applied tag style: ${style}`);
    }
    
    // 4. Character appearance (if enabled)
    if (settings.extractAppearance === true) {
        const charAppearance = extractCharacterAppearance();
        if (charAppearance) {
            promptParts.push(`[Character Reference: ${charAppearance}]`);
            iigLog('INFO', `✓ Applied character appearance`);
        }
    }
    
    // 5. User appearance (if enabled - separate setting)
    if (settings.extractUserAppearance !== false) { // Default true for backwards compatibility
        const userAppearance = extractUserAppearance();
        if (userAppearance) {
            promptParts.push(`[User Reference: ${userAppearance}]`);
            iigLog('INFO', `✓ Applied user appearance`);
        }
    }
    
    // 6. Detected clothing (if enabled)
    if (settings.detectClothing === true) {
        const depth = settings.clothingSearchDepth || 5;
        const clothing = detectClothingFromChat(depth);
        if (clothing) {
            promptParts.push(`[Current Clothing: ${clothing}]`);
            iigLog('INFO', `✓ Applied clothing detection`);
        }
    }
    
    // 7. Main prompt (from the tag)
    promptParts.push(basePrompt);
    
    // 8. Negative prompt (at the end as instruction)
    if (settings.negativePrompt && settings.negativePrompt.trim() !== '') {
        promptParts.push(`[AVOID: ${settings.negativePrompt.trim()}]`);
        iigLog('INFO', `✓ Applied negative prompt: ${settings.negativePrompt.substring(0, 50)}`);
    } else {
        iigLog('INFO', `✗ Negative prompt NOT applied (value="${settings.negativePrompt || ''}")`);
    }
    
    const fullPrompt = promptParts.join('\n\n');
    iigLog('INFO', `Built enhanced prompt (${fullPrompt.length} chars, ${promptParts.length} parts)`);
    iigLog('INFO', `Full prompt preview: ${fullPrompt.substring(0, 200)}...`);
    
    return fullPrompt;
}

/**
 * Generate image via OpenAI-compatible endpoint
 */
async function generateImageOpenAI(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1/images/generations`;
    
    // Use enhanced prompt builder
    const fullPrompt = buildEnhancedPrompt(prompt, style, options);
    
    // Map aspect ratio to size if provided in tag
    let size = settings.size;
    if (options.aspectRatio) {
        if (options.aspectRatio === '16:9') size = '1792x1024';
        else if (options.aspectRatio === '9:16') size = '1024x1792';
        else if (options.aspectRatio === '1:1') size = '1024x1024';
    }
    
    const body = {
        model: settings.model,
        prompt: fullPrompt,
        n: 1,
        size: size,
        quality: options.quality || settings.quality,
        response_format: 'b64_json'
    };
    
    // Add reference image if supported (for models like GPT-Image-1, FLUX)
    if (referenceImages.length > 0) {
        body.image = `data:image/png;base64,${referenceImages[0]}`;
    }
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    // Parse response - standard OpenAI format
    const dataList = result.data || [];
    if (dataList.length === 0) {
        if (result.url) return result.url;
        throw new Error('No image data in response');
    }
    
    const imageObj = dataList[0];
    const imageData = imageObj.b64_json || imageObj.url;
    
    // Return as data URL if b64_json
    if (imageObj.b64_json) {
        return `data:image/png;base64,${imageObj.b64_json}`;
    }
    
    return imageData;
}

// Valid aspect ratios for Gemini/nano-banana
const VALID_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
// Valid image sizes for Gemini/nano-banana
const VALID_IMAGE_SIZES = ['1K', '2K', '4K'];

/**
 * Generate image via Gemini-compatible endpoint (nano-banana)
 */
async function generateImageGemini(prompt, style, referenceImages = [], options = {}) {
    const settings = getSettings();
    const model = settings.model;
    const url = `${settings.endpoint.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
    
    // Determine aspect ratio: tag option > settings, with validation
    let aspectRatio = options.aspectRatio || settings.aspectRatio || '1:1';
    if (!VALID_ASPECT_RATIOS.includes(aspectRatio)) {
        iigLog('WARN', `Invalid aspect_ratio "${aspectRatio}", falling back to settings or default`);
        aspectRatio = VALID_ASPECT_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : '1:1';
    }
    
    // Determine image size: tag option > settings, with validation
    let imageSize = options.imageSize || settings.imageSize || '1K';
    if (!VALID_IMAGE_SIZES.includes(imageSize)) {
        iigLog('WARN', `Invalid image_size "${imageSize}", falling back to settings or default`);
        imageSize = VALID_IMAGE_SIZES.includes(settings.imageSize) ? settings.imageSize : '1K';
    }
    
    iigLog('INFO', `Using aspect ratio: ${aspectRatio}, image size: ${imageSize}`);
    
    // Build parts array
    const parts = [];
    
    // Add reference images first (up to 4)
    for (const imgB64 of referenceImages.slice(0, 4)) {
        parts.push({
            inlineData: {
                mimeType: 'image/png',
                data: imgB64
            }
        });
    }
    
    // Use enhanced prompt builder for nano-banana (main focus)
    let fullPrompt = buildEnhancedPrompt(prompt, style, options);
    
    // If reference images provided, add instruction to copy appearance
    if (referenceImages.length > 0) {
        const refInstruction = `[CRITICAL: The reference image(s) above show the EXACT appearance of the character(s). You MUST precisely copy their: face structure, eye color, hair color and style, skin tone, body type, clothing, and all distinctive features. Do not deviate from the reference appearances.]`;
        fullPrompt = `${refInstruction}\n\n${fullPrompt}`;
    }
    
    parts.push({ text: fullPrompt });
    
    console.log(`[IIG] Gemini request: ${referenceImages.length} reference image(s) + prompt (${fullPrompt.length} chars)`);
    
    const body = {
        contents: [{
            role: 'user',
            parts: parts
        }],
        generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {
                aspectRatio: aspectRatio,
                imageSize: imageSize
            }
        }
    };
    
    // Log full request config for debugging 400 errors
    iigLog('INFO', `Gemini request config: model=${model}, aspectRatio=${aspectRatio}, imageSize=${imageSize}, promptLength=${fullPrompt.length}, refImages=${referenceImages.length}`);
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${settings.apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`API Error (${response.status}): ${text}`);
    }
    
    const result = await response.json();
    
    // Parse Gemini response
    const candidates = result.candidates || [];
    if (candidates.length === 0) {
        throw new Error('No candidates in response');
    }
    
    const responseParts = candidates[0].content?.parts || [];
    
    for (const part of responseParts) {
        // Check both camelCase and snake_case variants
        if (part.inlineData) {
            return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
        if (part.inline_data) {
            return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        }
    }
    
    throw new Error('No image found in Gemini response');
}

/**
 * Validate settings before generation
 */
function validateSettings() {
    const settings = getSettings();
    const errors = [];
    
    if (!settings.endpoint) {
        errors.push('URL эндпоинта не настроен');
    }
    if (!settings.apiKey) {
        errors.push('API ключ не настроен');
    }
    if (!settings.model) {
        errors.push('Модель не выбрана');
    }
    
    if (errors.length > 0) {
        throw new Error(`Ошибка настроек: ${errors.join(', ')}`);
    }
}

/**
 * Sanitize text for safe HTML display
 */
function sanitizeForHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Generate image with retry logic
 * @param {string} prompt - Image description
 * @param {string} style - Style tag
 * @param {function} onStatusUpdate - Status callback
 * @param {object} options - Additional options (aspectRatio, quality)
 */
async function generateImageWithRetry(prompt, style, onStatusUpdate, options = {}) {
    // Validate settings first
    validateSettings();
    
    const settings = getSettings();
    const maxRetries = settings.maxRetries;
    const baseDelay = settings.retryDelay;
    
    // Collect reference images if enabled (for Gemini/nano-banana)
    const referenceImages = [];
    
    if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
        if (settings.sendCharAvatar) {
            console.log('[IIG] Fetching character avatar for reference...');
            const charAvatar = await getCharacterAvatarBase64();
            if (charAvatar) {
                referenceImages.push(charAvatar);
                console.log('[IIG] Character avatar added to references');
            }
        }
        
        if (settings.sendUserAvatar) {
            console.log('[IIG] Fetching user avatar for reference...');
            const userAvatar = await getUserAvatarBase64();
            if (userAvatar) {
                referenceImages.push(userAvatar);
                console.log('[IIG] User avatar added to references');
            }
        }
        
        console.log(`[IIG] Total reference images: ${referenceImages.length}`);
    }
    
    let lastError;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            onStatusUpdate?.(`Генерация${attempt > 0 ? ` (повтор ${attempt}/${maxRetries})` : ''}...`);
            
            // Choose API based on type or model
            if (settings.apiType === 'gemini' || isGeminiModel(settings.model)) {
                return await generateImageGemini(prompt, style, referenceImages, options);
            } else {
                return await generateImageOpenAI(prompt, style, referenceImages, options);
            }
        } catch (error) {
            lastError = error;
            console.error(`[IIG] Generation attempt ${attempt + 1} failed:`, error);
            
            // Check if retryable
            const isRetryable = error.message?.includes('429') ||
                               error.message?.includes('503') ||
                               error.message?.includes('502') ||
                               error.message?.includes('504') ||
                               error.message?.includes('timeout') ||
                               error.message?.includes('network');
            
            if (!isRetryable || attempt === maxRetries) {
                break;
            }
            
            const delay = baseDelay * Math.pow(2, attempt);
            onStatusUpdate?.(`Повтор через ${delay / 1000}с...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

/**
 * Check if a file exists on the server
 */
async function checkFileExists(path) {
    try {
        const response = await fetch(path, { method: 'HEAD' });
        return response.ok;
    } catch (e) {
        return false;
    }
}

/**
 * Parse image generation tags from message text
 * Supports two formats:
 * 1. NEW: <img data-iig-instruction='{"style":"...","prompt":"..."}' src="[IMG:GEN]">
 * 2. LEGACY: [IMG:GEN:{"style":"...","prompt":"..."}]
 * 
 * @param {string} text - Message text
 * @param {object} options - Options
 * @param {boolean} options.checkExistence - Check if image files exist (for hallucination detection)
 * @param {boolean} options.forceAll - Include all instruction tags even with valid paths (for regeneration)
 */
async function parseImageTags(text, options = {}) {
    const { checkExistence = false, forceAll = false } = options;
    const tags = [];
    
    // === NEW FORMAT: <img data-iig-instruction="{...}" src="[IMG:GEN]"> ===
    // LLM often generates broken HTML with unescaped quotes, so we parse manually
    const imgTagMarker = 'data-iig-instruction=';
    let searchPos = 0;
    
    while (true) {
        const markerPos = text.indexOf(imgTagMarker, searchPos);
        if (markerPos === -1) break;
        
        // Find the start of the <img tag
        let imgStart = text.lastIndexOf('<img', markerPos);
        if (imgStart === -1 || markerPos - imgStart > 500) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find the JSON start (first { after the marker)
        const afterMarker = markerPos + imgTagMarker.length;
        let jsonStart = text.indexOf('{', afterMarker);
        if (jsonStart === -1 || jsonStart > afterMarker + 10) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find matching closing brace using brace counting
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        
        // Find the end of the <img> tag
        let imgEnd = text.indexOf('>', jsonEnd);
        if (imgEnd === -1) {
            searchPos = markerPos + 1;
            continue;
        }
        imgEnd++; // Include the >
        
        const fullImgTag = text.substring(imgStart, imgEnd);
        const instructionJson = text.substring(jsonStart, jsonEnd);
        
        // Check if src needs generation
        const srcMatch = fullImgTag.match(/src\s*=\s*["']?([^"'\s>]+)/i);
        const srcValue = srcMatch ? srcMatch[1] : '';
        
        // Determine if this needs generation
        let needsGeneration = false;
        const hasMarker = srcValue.includes('[IMG:GEN]') || srcValue.includes('[IMG:');
        const hasErrorImage = srcValue.includes('error.svg'); // Our error placeholder - NO auto-retry
        const hasPath = srcValue && srcValue.startsWith('/') && srcValue.length > 5;
        
        // Skip error images - user must click to retry manually (prevents conflict on swipe)
        if (hasErrorImage && !forceAll) {
            iigLog('INFO', `Skipping error image (click to retry): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (forceAll) {
            // Regeneration mode: include all tags with instruction (user-triggered)
            needsGeneration = true;
            iigLog('INFO', `Force regeneration mode: including ${srcValue.substring(0, 30)}`);
        } else if (hasMarker || !srcValue) {
            // Explicit marker or empty src = needs generation
            needsGeneration = true;
        } else if (hasPath && checkExistence) {
            // Has a path - check if file actually exists
            const exists = await checkFileExists(srcValue);
            if (!exists) {
                // File doesn't exist = LLM hallucinated the path
                iigLog('WARN', `File does not exist (LLM hallucination?): ${srcValue}`);
                needsGeneration = true;
            } else {
                iigLog('INFO', `Skipping existing image: ${srcValue.substring(0, 50)}`);
            }
        } else if (hasPath) {
            // Has path but not checking existence - skip
            iigLog('INFO', `Skipping path (no existence check): ${srcValue.substring(0, 50)}`);
            searchPos = imgEnd;
            continue;
        }
        
        if (!needsGeneration) {
            searchPos = imgEnd;
            continue;
        }
        
        try {
            // Normalize JSON: AI sometimes uses single quotes, HTML entities, etc.
            let normalizedJson = instructionJson
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&#39;/g, "'")
                .replace(/&#34;/g, '"')
                .replace(/&amp;/g, '&');
            
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: fullImgTag,
                index: imgStart,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: true,
                existingSrc: hasPath ? srcValue : null // Store existing src for logging
            });
            
            iigLog('INFO', `Found NEW format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse instruction JSON: ${instructionJson.substring(0, 100)}`, e.message);
        }
        
        searchPos = imgEnd;
    }
    
    // === LEGACY FORMAT: [IMG:GEN:{...}] ===
    const marker = '[IMG:GEN:';
    let searchStart = 0;
    
    while (true) {
        const markerIndex = text.indexOf(marker, searchStart);
        if (markerIndex === -1) break;
        
        const jsonStart = markerIndex + marker.length;
        
        // Find the matching closing brace for JSON
        let braceCount = 0;
        let jsonEnd = -1;
        let inString = false;
        let escapeNext = false;
        
        for (let i = jsonStart; i < text.length; i++) {
            const char = text[i];
            
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            
            if (char === '\\' && inString) {
                escapeNext = true;
                continue;
            }
            
            if (char === '"') {
                inString = !inString;
                continue;
            }
            
            if (!inString) {
                if (char === '{') {
                    braceCount++;
                } else if (char === '}') {
                    braceCount--;
                    if (braceCount === 0) {
                        jsonEnd = i + 1;
                        break;
                    }
                }
            }
        }
        
        if (jsonEnd === -1) {
            searchStart = jsonStart;
            continue;
        }
        
        const jsonStr = text.substring(jsonStart, jsonEnd);
        
        const afterJson = text.substring(jsonEnd);
        if (!afterJson.startsWith(']')) {
            searchStart = jsonEnd;
            continue;
        }
        
        const tagOnly = text.substring(markerIndex, jsonEnd + 1);
        
        try {
            const normalizedJson = jsonStr.replace(/'/g, '"');
            const data = JSON.parse(normalizedJson);
            
            tags.push({
                fullMatch: tagOnly,
                index: markerIndex,
                style: data.style || '',
                prompt: data.prompt || '',
                aspectRatio: data.aspect_ratio || data.aspectRatio || null,
                imageSize: data.image_size || data.imageSize || null,
                quality: data.quality || null,
                isNewFormat: false
            });
            
            iigLog('INFO', `Found LEGACY format tag: ${data.prompt?.substring(0, 50)}`);
        } catch (e) {
            iigLog('WARN', `Failed to parse legacy tag JSON: ${jsonStr.substring(0, 100)}`, e.message);
        }
        
        searchStart = jsonEnd + 1;
    }
    
    return tags;
}

/**
 * Create loading placeholder element
 */
function createLoadingPlaceholder(tagId) {
    const placeholder = document.createElement('div');
    placeholder.className = 'iig-loading-placeholder';
    placeholder.dataset.tagId = tagId;
    placeholder.innerHTML = `
        <div class="iig-spinner"></div>
        <div class="iig-status">Генерация картинки...</div>
    `;
    return placeholder;
}

// Error image path - served from extension folder
const ERROR_IMAGE_PATH = '/scripts/extensions/third-party/sillyimages/error.svg';

/**
 * Create error placeholder element - just shows error.svg, no click handlers
 * User uses the regenerate button in message menu to retry
 */
function createErrorPlaceholder(tagId, errorMessage, tagInfo) {
    const img = document.createElement('img');
    img.className = 'iig-error-image';
    img.src = ERROR_IMAGE_PATH;
    img.alt = 'Ошибка генерации';
    img.title = `Ошибка: ${errorMessage}`;
    img.dataset.tagId = tagId;
    
    // Preserve data-iig-instruction for regenerate button functionality
    if (tagInfo.fullMatch) {
        const instructionMatch = tagInfo.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
        if (instructionMatch) {
            img.setAttribute('data-iig-instruction', instructionMatch[2]);
        }
    }
    
    return img;
}

/**
 * Process image tags in a message
 */
async function processMessageTags(messageId) {
    const context = SillyTavern.getContext();
    const settings = getSettings();
    
    if (!settings.enabled) return;
    
    // Prevent duplicate processing
    if (processingMessages.has(messageId)) {
        iigLog('WARN', `Message ${messageId} is already being processed, skipping`);
        return;
    }
    
    const message = context.chat[messageId];
    if (!message || message.is_user) return;
    
    // Check for tags, with file existence check to catch LLM hallucinations
    const tags = await parseImageTags(message.mes, { checkExistence: true });
    iigLog('INFO', `parseImageTags returned: ${tags.length} tags`);
    if (tags.length > 0) {
        iigLog('INFO', `First tag: ${JSON.stringify(tags[0]).substring(0, 200)}`);
    }
    if (tags.length === 0) {
        iigLog('INFO', 'No tags found by parser');
        return;
    }
    
    // Mark as processing
    processingMessages.add(messageId);
    iigLog('INFO', `Found ${tags.length} image tag(s) in message ${messageId}`);
    toastr.info(`Найдено тегов: ${tags.length}. Генерация...`, 'Генерация картинок', { timeOut: 3000 });
    
    // DOM is ready because we use CHARACTER_MESSAGE_RENDERED event
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        console.error('[IIG] Message element not found for ID:', messageId);
        toastr.error('Не удалось найти элемент сообщения', 'Генерация картинок');
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) return;
    
    // Process each tag in parallel
    const processTag = async (tag, index) => {
        const tagId = `iig-${messageId}-${index}`;
        
        iigLog('INFO', `Processing tag ${index}: ${tag.fullMatch.substring(0, 50)}`);
        
        // Create loading placeholder
        const loadingPlaceholder = createLoadingPlaceholder(tagId);
        let targetElement = null;
        
        if (tag.isNewFormat) {
            // NEW FORMAT: <img data-iig-instruction='...'> is a real DOM element
            // Find it by looking for img with data-iig-instruction attribute
            const allImgs = mesTextEl.querySelectorAll('img[data-iig-instruction]');
            iigLog('INFO', `Searching for img element. Found ${allImgs.length} img[data-iig-instruction] elements in DOM`);
            
            // Debug: log what we're looking for vs what's in DOM
            const searchPrompt = tag.prompt.substring(0, 30);
            iigLog('INFO', `Searching for prompt starting with: "${searchPrompt}"`);
            
            for (const img of allImgs) {
                const instruction = img.getAttribute('data-iig-instruction');
                const src = img.getAttribute('src') || '';
                iigLog('INFO', `DOM img - src: "${src.substring(0, 50)}", instruction (first 100): "${instruction?.substring(0, 100)}"`);
                
                // Try multiple matching strategies
                if (instruction) {
                    // Strategy 1: Decode HTML entities and normalize quotes, then match
                    const decodedInstruction = instruction
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    // Also normalize the search prompt the same way
                    const normalizedSearchPrompt = searchPrompt
                        .replace(/&quot;/g, '"')
                        .replace(/&apos;/g, "'")
                        .replace(/&#39;/g, "'")
                        .replace(/&#34;/g, '"')
                        .replace(/&amp;/g, '&');
                    
                    // Check if decoded instruction contains the prompt
                    if (decodedInstruction.includes(normalizedSearchPrompt)) {
                        iigLog('INFO', `Found img element via decoded instruction match`);
                        targetElement = img;
                        break;
                    }
                    
                    // Strategy 2: Try to parse the instruction as JSON and compare prompts
                    try {
                        const normalizedJson = decodedInstruction.replace(/'/g, '"');
                        const instructionData = JSON.parse(normalizedJson);
                        if (instructionData.prompt && instructionData.prompt.substring(0, 30) === tag.prompt.substring(0, 30)) {
                            iigLog('INFO', `Found img element via JSON prompt match`);
                            targetElement = img;
                            break;
                        }
                    } catch (e) {
                        // JSON parse failed, continue with other strategies
                    }
                    
                    // Strategy 3: Raw instruction contains raw search prompt (original approach)
                    if (instruction.includes(searchPrompt)) {
                        iigLog('INFO', `Found img element via raw instruction match`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            // Alternative: find by src containing markers (when prompt matching fails)
            if (!targetElement) {
                iigLog('INFO', `Prompt matching failed, trying src marker matching...`);
                for (const img of allImgs) {
                    const src = img.getAttribute('src') || '';
                    // Check for generation markers or empty/broken src
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]') || src === '' || src === '#') {
                        iigLog('INFO', `Found img element with generation marker in src: "${src}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
            
            // Strategy 4: If still not found, try looking at ALL imgs (not just those with data-iig-instruction attr)
            // This handles cases where browser didn't parse data-iig-instruction as a valid attribute
            if (!targetElement) {
                iigLog('INFO', `Trying broader img search...`);
                const allImgsInMes = mesTextEl.querySelectorAll('img');
                for (const img of allImgsInMes) {
                    const src = img.getAttribute('src') || '';
                    // Look for src containing our markers
                    if (src.includes('[IMG:GEN]') || src.includes('[IMG:ERROR]')) {
                        iigLog('INFO', `Found img via broad search with marker src: "${src.substring(0, 50)}"`);
                        targetElement = img;
                        break;
                    }
                }
            }
        } else {
            // LEGACY FORMAT: [IMG:GEN:{...}] - use regex replacement
            const tagEscaped = tag.fullMatch
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(/"/g, '(?:"|&quot;)');
            const tagRegex = new RegExp(tagEscaped, 'g');
            
            const beforeReplace = mesTextEl.innerHTML;
            mesTextEl.innerHTML = mesTextEl.innerHTML.replace(
                tagRegex,
                `<span data-iig-placeholder="${tagId}"></span>`
            );
            
            if (beforeReplace !== mesTextEl.innerHTML) {
                targetElement = mesTextEl.querySelector(`[data-iig-placeholder="${tagId}"]`);
                iigLog('INFO', `Legacy tag replaced with placeholder span`);
            }
            
            // Also check for img src containing legacy tag
            if (!targetElement) {
                const allImgs = mesTextEl.querySelectorAll('img');
                for (const img of allImgs) {
                    if (img.src && img.src.includes('[IMG:GEN:')) {
                        targetElement = img;
                        iigLog('INFO', `Found img with legacy tag in src`);
                        break;
                    }
                }
            }
        }
        
        // Replace target with placeholder, preserving parent styling context
        if (targetElement) {
            // Copy some styling context from parent for adaptive placeholder
            const parent = targetElement.parentElement;
            if (parent) {
                const parentStyle = window.getComputedStyle(parent);
                if (parentStyle.display === 'flex' || parentStyle.display === 'grid') {
                    loadingPlaceholder.style.alignSelf = 'center';
                }
            }
            targetElement.replaceWith(loadingPlaceholder);
            iigLog('INFO', `Loading placeholder shown (replaced target element)`);
        } else {
            iigLog('WARN', `Could not find target element, appending placeholder as fallback`);
            mesTextEl.appendChild(loadingPlaceholder);
        }
        
        const statusEl = loadingPlaceholder.querySelector('.iig-status');
        
        try {
            const dataUrl = await generateImageWithRetry(
                tag.prompt,
                tag.style,
                (status) => { statusEl.textContent = status; },
                { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
            );
            
            // Save image to file instead of keeping base64
            statusEl.textContent = 'Сохранение...';
            const imagePath = await saveImageToFile(dataUrl);
            
            // Replace placeholder with actual image
            const img = document.createElement('img');
            img.className = 'iig-generated-image';
            img.src = imagePath;
            img.alt = tag.prompt;
            img.title = `Style: ${tag.style}\nPrompt: ${tag.prompt}`;
            
            // Preserve instruction for future regenerations (new format only)
            if (tag.isNewFormat) {
                const instructionMatch = tag.fullMatch.match(/data-iig-instruction\s*=\s*(['"])([\s\S]*?)\1/i);
                if (instructionMatch) {
                    img.setAttribute('data-iig-instruction', instructionMatch[2]);
                }
            }
            
            loadingPlaceholder.replaceWith(img);
            
            // Update message.mes to persist the image
            if (tag.isNewFormat) {
                // NEW FORMAT: <img data-iig-instruction="..." src="[IMG:GEN]">
                // Just update the src attribute with the real path
                // LLM sees same format but with real path = already generated
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
            } else {
                // LEGACY FORMAT: [IMG:GEN:{...}]
                // Replace with completion marker so LLM doesn't copy it
                const completionMarker = `[IMG:✓:${imagePath}]`;
                message.mes = message.mes.replace(tag.fullMatch, completionMarker);
            }
            
            iigLog('INFO', `Successfully generated image for tag ${index}`);
            toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
        } catch (error) {
            iigLog('ERROR', `Failed to generate image for tag ${index}:`, error.message);
            
            // Replace with error placeholder
            const errorPlaceholder = createErrorPlaceholder(tagId, error.message, tag);
            loadingPlaceholder.replaceWith(errorPlaceholder);
            
            // IMPORTANT: Mark tag as failed in message.mes - use error.svg path so it displays properly after swipe
            if (tag.isNewFormat) {
                // NEW FORMAT: update src with error image path (will be detected for retry)
                const errorTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${ERROR_IMAGE_PATH}"`);
                message.mes = message.mes.replace(tag.fullMatch, errorTag);
            } else {
                // LEGACY FORMAT: replace with error marker
                const errorMarker = `[IMG:ERROR:${error.message.substring(0, 50)}]`;
                message.mes = message.mes.replace(tag.fullMatch, errorMarker);
            }
            iigLog('INFO', `Marked tag as failed in message.mes`);
            
            toastr.error(`Ошибка генерации: ${error.message}`, 'Генерация картинок');
        }
    };
    
    try {
        // Process all tags in parallel
        await Promise.all(tags.map((tag, index) => processTag(tag, index)));
    } finally {
        // Always remove from processing set
        processingMessages.delete(messageId);
        iigLog('INFO', `Finished processing message ${messageId}`);
    }
    
    // Save chat to persist changes
    await context.saveChat();
    
    // Force re-render the message to show updated content
    // Use SillyTavern's messageFormatting if available
    if (typeof context.messageFormatting === 'function') {
        const formattedMessage = context.messageFormatting(
            message.mes,
            message.name,
            message.is_system,
            message.is_user,
            messageId
        );
        mesTextEl.innerHTML = formattedMessage;
        console.log('[IIG] Message re-rendered via messageFormatting');
    } else {
        // Fallback: trigger a manual re-render by finding and updating the element
        const freshMessageEl = document.querySelector(`#chat .mes[mesid="${messageId}"] .mes_text`);
        if (freshMessageEl && message.mes) {
            // Simple approach: just reload the message content
            // This works because message.mes now contains the image path instead of the tag
            console.log('[IIG] Attempting manual refresh...');
        }
    }
}

/**
 * Regenerate all images in a message (user-triggered)
 */
async function regenerateMessageImages(messageId) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    if (!message) {
        toastr.error('Сообщение не найдено', 'Генерация картинок');
        return;
    }
    
    // Parse ALL instruction tags, forcing regeneration
    const tags = await parseImageTags(message.mes, { forceAll: true });
    
    if (tags.length === 0) {
        toastr.warning('Нет тегов для перегенерации', 'Генерация картинок');
        return;
    }
    
    iigLog('INFO', `Regenerating ${tags.length} images in message ${messageId}`);
    toastr.info(`Перегенерация ${tags.length} картинок...`, 'Генерация картинок');
    
    // Process using existing logic
    processingMessages.add(messageId);
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) {
        processingMessages.delete(messageId);
        return;
    }
    
    const mesTextEl = messageElement.querySelector('.mes_text');
    if (!mesTextEl) {
        processingMessages.delete(messageId);
        return;
    }
    
    for (let index = 0; index < tags.length; index++) {
        const tag = tags[index];
        const tagId = `iig-regen-${messageId}-${index}`;
        
        try {
            // Find the existing img element with data-iig-instruction
            const existingImg = mesTextEl.querySelector(`img[data-iig-instruction]`);
            if (existingImg) {
                // Preserve the instruction for future regenerations
                const instruction = existingImg.getAttribute('data-iig-instruction');
                
                const loadingPlaceholder = createLoadingPlaceholder(tagId);
                existingImg.replaceWith(loadingPlaceholder);
                
                const statusEl = loadingPlaceholder.querySelector('.iig-status');
                
                const dataUrl = await generateImageWithRetry(
                    tag.prompt,
                    tag.style,
                    (status) => { statusEl.textContent = status; },
                    { aspectRatio: tag.aspectRatio, imageSize: tag.imageSize, quality: tag.quality }
                );
                
                statusEl.textContent = 'Сохранение...';
                const imagePath = await saveImageToFile(dataUrl);
                
                const img = document.createElement('img');
                img.className = 'iig-generated-image';
                img.src = imagePath;
                img.alt = tag.prompt;
                // Preserve instruction for future regenerations
                if (instruction) {
                    img.setAttribute('data-iig-instruction', instruction);
                }
                loadingPlaceholder.replaceWith(img);
                
                // Update message.mes
                const updatedTag = tag.fullMatch.replace(/src\s*=\s*(['"])[^'"]*\1/i, `src="${imagePath}"`);
                message.mes = message.mes.replace(tag.fullMatch, updatedTag);
                
                toastr.success(`Картинка ${index + 1}/${tags.length} готова`, 'Генерация картинок', { timeOut: 2000 });
            }
        } catch (error) {
            iigLog('ERROR', `Regeneration failed for tag ${index}:`, error.message);
            toastr.error(`Ошибка: ${error.message}`, 'Генерация картинок');
        }
    }
    
    processingMessages.delete(messageId);
    await context.saveChat();
    iigLog('INFO', `Regeneration complete for message ${messageId}`);
}

/**
 * Add regenerate button to message extra menu (three dots)
 */
function addRegenerateButton(messageElement, messageId) {
    // Check if button already exists
    if (messageElement.querySelector('.iig-regenerate-btn')) return;
    
    // Find the extraMesButtons container (three dots menu)
    const extraMesButtons = messageElement.querySelector('.extraMesButtons');
    if (!extraMesButtons) return;
    
    const btn = document.createElement('div');
    btn.className = 'mes_button iig-regenerate-btn fa-solid fa-images interactable';
    btn.title = 'Перегенерировать картинки';
    btn.tabIndex = 0;
    btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await regenerateMessageImages(messageId);
    });
    
    extraMesButtons.appendChild(btn);
}

/**
 * Add regenerate buttons to all existing AI messages in chat
 */
function addButtonsToExistingMessages() {
    const context = SillyTavern.getContext();
    if (!context.chat || context.chat.length === 0) return;
    
    const messageElements = document.querySelectorAll('#chat .mes');
    let addedCount = 0;
    
    for (const messageElement of messageElements) {
        const mesId = messageElement.getAttribute('mesid');
        if (mesId === null) continue;
        
        const messageId = parseInt(mesId, 10);
        const message = context.chat[messageId];
        
        // Only add to AI messages (not user messages)
        if (message && !message.is_user) {
            addRegenerateButton(messageElement, messageId);
            addedCount++;
        }
    }
    
    iigLog('INFO', `Added regenerate buttons to ${addedCount} existing messages`);
}

// NOTE: No click handlers on error images - user uses the regenerate button in message menu

/**
 * Handle CHARACTER_MESSAGE_RENDERED event
 * This fires AFTER the message is rendered to DOM
 */
async function onMessageReceived(messageId) {
    iigLog('INFO', `onMessageReceived: ${messageId}`);
    
    const settings = getSettings();
    if (!settings.enabled) {
        iigLog('INFO', 'Extension disabled, skipping');
        return;
    }
    
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    
    const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!messageElement) return;
    
    // Always add regenerate button for AI messages
    addRegenerateButton(messageElement, messageId);
    
    await processMessageTags(messageId);
}

/**
 * Create settings UI
 */
function createSettingsUI() {
    const settings = getSettings();
    const context = SillyTavern.getContext();
    
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.error('[IIG] Settings container not found');
        return;
    }
    
    const html = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Генерация картинок</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="iig-settings">
                    <!-- Вкл/Выкл -->
                    <label class="checkbox_label">
                        <input type="checkbox" id="iig_enabled" ${settings.enabled ? 'checked' : ''}>
                        <span>Включить генерацию картинок</span>
                    </label>
                    
                    <hr>
                    
                    <h4>Настройки API</h4>
                    
                    <!-- Тип эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_api_type">Тип API</label>
                        <select id="iig_api_type" class="flex1">
                            <option value="openai" ${settings.apiType === 'openai' ? 'selected' : ''}>OpenAI-совместимый (/v1/images/generations)</option>
                            <option value="gemini" ${settings.apiType === 'gemini' ? 'selected' : ''}>Gemini-совместимый (nano-banana)</option>
                        </select>
                    </div>
                    
                    <!-- URL эндпоинта -->
                    <div class="flex-row">
                        <label for="iig_endpoint">URL эндпоинта</label>
                        <input type="text" id="iig_endpoint" class="text_pole flex1" 
                               value="${settings.endpoint}" 
                               placeholder="https://api.example.com">
                    </div>
                    
                    <!-- API ключ -->
                    <div class="flex-row">
                        <label for="iig_api_key">API ключ</label>
                        <input type="password" id="iig_api_key" class="text_pole flex1" 
                               value="${settings.apiKey}">
                        <div id="iig_key_toggle" class="menu_button iig-key-toggle" title="Показать/Скрыть">
                            <i class="fa-solid fa-eye"></i>
                        </div>
                    </div>
                    
                    <!-- Модель -->
                    <div class="flex-row">
                        <label for="iig_model">Модель</label>
                        <select id="iig_model" class="flex1">
                            ${settings.model ? `<option value="${settings.model}" selected>${settings.model}</option>` : '<option value="">-- Выберите модель --</option>'}
                        </select>
                        <div id="iig_refresh_models" class="menu_button iig-refresh-btn" title="Обновить список">
                            <i class="fa-solid fa-sync"></i>
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Параметры генерации</h4>
                    
                    <!-- Размер -->
                    <div class="flex-row">
                        <label for="iig_size">Размер</label>
                        <select id="iig_size" class="flex1">
                            <option value="1024x1024" ${settings.size === '1024x1024' ? 'selected' : ''}>1024x1024 (Квадрат)</option>
                            <option value="1792x1024" ${settings.size === '1792x1024' ? 'selected' : ''}>1792x1024 (Альбомная)</option>
                            <option value="1024x1792" ${settings.size === '1024x1792' ? 'selected' : ''}>1024x1792 (Портретная)</option>
                            <option value="512x512" ${settings.size === '512x512' ? 'selected' : ''}>512x512 (Маленький)</option>
                        </select>
                    </div>
                    
                    <!-- Качество -->
                    <div class="flex-row">
                        <label for="iig_quality">Качество</label>
                        <select id="iig_quality" class="flex1">
                            <option value="standard" ${settings.quality === 'standard' ? 'selected' : ''}>Стандартное</option>
                            <option value="hd" ${settings.quality === 'hd' ? 'selected' : ''}>HD</option>
                        </select>
                    </div>
                    
                    <hr>
                    
                    <!-- Опции для Nano-Banana -->
                    <div id="iig_avatar_section" class="iig-avatar-section ${settings.apiType !== 'gemini' ? 'hidden' : ''}">
                        <h4>Настройки Nano-Banana</h4>
                        
                        <!-- Aspect Ratio -->
                        <div class="flex-row">
                            <label for="iig_aspect_ratio">Соотношение сторон</label>
                            <select id="iig_aspect_ratio" class="flex1">
                                <option value="1:1" ${settings.aspectRatio === '1:1' ? 'selected' : ''}>1:1 (Квадрат)</option>
                                <option value="2:3" ${settings.aspectRatio === '2:3' ? 'selected' : ''}>2:3 (Портрет)</option>
                                <option value="3:2" ${settings.aspectRatio === '3:2' ? 'selected' : ''}>3:2 (Альбом)</option>
                                <option value="3:4" ${settings.aspectRatio === '3:4' ? 'selected' : ''}>3:4 (Портрет)</option>
                                <option value="4:3" ${settings.aspectRatio === '4:3' ? 'selected' : ''}>4:3 (Альбом)</option>
                                <option value="4:5" ${settings.aspectRatio === '4:5' ? 'selected' : ''}>4:5 (Портрет)</option>
                                <option value="5:4" ${settings.aspectRatio === '5:4' ? 'selected' : ''}>5:4 (Альбом)</option>
                                <option value="9:16" ${settings.aspectRatio === '9:16' ? 'selected' : ''}>9:16 (Вертикальный)</option>
                                <option value="16:9" ${settings.aspectRatio === '16:9' ? 'selected' : ''}>16:9 (Широкий)</option>
                                <option value="21:9" ${settings.aspectRatio === '21:9' ? 'selected' : ''}>21:9 (Ультраширокий)</option>
                            </select>
                        </div>
                        
                        <!-- Image Size -->
                        <div class="flex-row">
                            <label for="iig_image_size">Разрешение</label>
                            <select id="iig_image_size" class="flex1">
                                <option value="1K" ${settings.imageSize === '1K' ? 'selected' : ''}>1K (по умолчанию)</option>
                                <option value="2K" ${settings.imageSize === '2K' ? 'selected' : ''}>2K</option>
                                <option value="4K" ${settings.imageSize === '4K' ? 'selected' : ''}>4K</option>
                            </select>
                        </div>
                        
                        <hr>
                        
                        <h5>Референсы</h5>
                        <p class="hint">Отправлять аватарки как референсы для консистентной генерации персонажей.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_char_avatar" ${settings.sendCharAvatar ? 'checked' : ''}>
                            <span>Отправлять аватар {{char}}</span>
                        </label>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_send_user_avatar" ${settings.sendUserAvatar ? 'checked' : ''}>
                            <span>Отправлять аватар {{user}}</span>
                        </label>
                        
                        <!-- User Avatar Selection -->
                        <div id="iig_user_avatar_row" class="flex-row ${!settings.sendUserAvatar ? 'hidden' : ''}" style="margin-top: 5px;">
                            <label for="iig_user_avatar_file">Аватар {{user}}</label>
                            <select id="iig_user_avatar_file" class="flex1">
                                <option value="">-- Не выбран --</option>
                                ${settings.userAvatarFile ? `<option value="${settings.userAvatarFile}" selected>${settings.userAvatarFile}</option>` : ''}
                            </select>
                            <div id="iig_refresh_avatars" class="menu_button iig-refresh-btn" title="Обновить список">
                                <i class="fa-solid fa-sync"></i>
                            </div>
                        </div>
                        
                        <hr>
                        
                        <h5>🎨 Пользовательские промпты</h5>
                        <p class="hint">Добавляются к каждой генерации. Positive - в начало, Negative - как инструкция избегания.</p>
                        
                        <!-- Positive Prompt -->
                        <div class="flex-col" style="margin-bottom: 8px;">
                            <label for="iig_positive_prompt">Positive промпт</label>
                            <textarea id="iig_positive_prompt" class="text_pole" rows="2" 
                                      placeholder="masterpiece, best quality, detailed...">${settings.positivePrompt || ''}</textarea>
                        </div>
                        
                        <!-- Negative Prompt -->
                        <div class="flex-col" style="margin-bottom: 8px;">
                            <label for="iig_negative_prompt">Negative промпт</label>
                            <textarea id="iig_negative_prompt" class="text_pole" rows="2" 
                                      placeholder="low quality, blurry, deformed...">${settings.negativePrompt || ''}</textarea>
                        </div>
                        
                        <hr>
                        
                        <h5>🖼️ Фиксированный стиль</h5>
                        <p class="hint">Стиль будет применяться ко ВСЕМ генерациям и не будет меняться.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_fixed_style_enabled" ${settings.fixedStyleEnabled ? 'checked' : ''}>
                            <span>Включить фиксированный стиль</span>
                        </label>
                        
                        <!-- Fixed Style Input -->
                        <div class="flex-col" style="margin-top: 5px;">
                            <label for="iig_fixed_style">Стиль (примеры: Avatar movie style, Anime Lycoris Recoil style, Cyberpunk 2077 game style)</label>
                            <input type="text" id="iig_fixed_style" class="text_pole" 
                                   value="${settings.fixedStyle || ''}" 
                                   placeholder="Anime semi-realistic style, detailed lighting...">
                        </div>
                        
                        <hr>
                        
                        <h5>👤 Извлечение внешности</h5>
                        <p class="hint">Автоматически извлекать описание внешности из карточек.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_extract_appearance" ${settings.extractAppearance ? 'checked' : ''}>
                            <span>Извлекать внешность {{char}} из карточки персонажа</span>
                        </label>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_extract_user_appearance" ${settings.extractUserAppearance !== false ? 'checked' : ''}>
                            <span>Извлекать внешность {{user}} из персоны</span>
                        </label>
                        
                        <hr>
                        
                        <h5>👕 Определение одежды</h5>
                        <p class="hint">Искать описания одежды в недавних сообщениях чата.</p>
                        
                        <label class="checkbox_label">
                            <input type="checkbox" id="iig_detect_clothing" ${settings.detectClothing ? 'checked' : ''}>
                            <span>Определять одежду из чата</span>
                        </label>
                        
                        <div class="flex-row" style="margin-top: 5px;">
                            <label for="iig_clothing_depth">Глубина поиска (сообщений)</label>
                            <input type="number" id="iig_clothing_depth" class="text_pole flex1" 
                                   value="${settings.clothingSearchDepth || 5}" min="1" max="20">
                        </div>
                    </div>
                    
                    <hr>
                    
                    <h4>Обработка ошибок</h4>
                    
                    <!-- Макс. повторов -->
                    <div class="flex-row">
                        <label for="iig_max_retries">Макс. повторов</label>
                        <input type="number" id="iig_max_retries" class="text_pole flex1" 
                               value="${settings.maxRetries}" min="0" max="5">
                    </div>
                    
                    <!-- Задержка -->
                    <div class="flex-row">
                        <label for="iig_retry_delay">Задержка (мс)</label>
                        <input type="number" id="iig_retry_delay" class="text_pole flex1" 
                               value="${settings.retryDelay}" min="500" max="10000" step="500">
                    </div>
                    
                    <hr>
                    
                    <h4>Отладка</h4>
                    
                    <div class="flex-row">
                        <div id="iig_export_logs" class="menu_button" style="width: 100%;">
                            <i class="fa-solid fa-download"></i> Экспорт логов
                        </div>
                    </div>
                    <p class="hint">Экспортировать логи расширения для отладки проблем.</p>
                </div>
            </div>
        </div>
    `;
    
    container.insertAdjacentHTML('beforeend', html);
    
    // Bind event handlers
    bindSettingsEvents();
}

/**
 * Bind settings event handlers
 */
function bindSettingsEvents() {
    const settings = getSettings();
    
    // Enable toggle
    document.getElementById('iig_enabled')?.addEventListener('change', (e) => {
        settings.enabled = e.target.checked;
        saveSettings();
    });
    
    // API Type
    document.getElementById('iig_api_type')?.addEventListener('change', (e) => {
        settings.apiType = e.target.value;
        saveSettings();
        
        // Show/hide avatar section
        const avatarSection = document.getElementById('iig_avatar_section');
        if (avatarSection) {
            avatarSection.classList.toggle('hidden', e.target.value !== 'gemini');
        }
    });
    
    // Endpoint
    document.getElementById('iig_endpoint')?.addEventListener('input', (e) => {
        settings.endpoint = e.target.value;
        saveSettings();
    });
    
    // API Key
    document.getElementById('iig_api_key')?.addEventListener('input', (e) => {
        settings.apiKey = e.target.value;
        saveSettings();
    });
    
    // API Key toggle visibility
    document.getElementById('iig_key_toggle')?.addEventListener('click', () => {
        const input = document.getElementById('iig_api_key');
        const icon = document.querySelector('#iig_key_toggle i');
        if (input.type === 'password') {
            input.type = 'text';
            icon.classList.replace('fa-eye', 'fa-eye-slash');
        } else {
            input.type = 'password';
            icon.classList.replace('fa-eye-slash', 'fa-eye');
        }
    });
    
    // Model
    document.getElementById('iig_model')?.addEventListener('change', (e) => {
        settings.model = e.target.value;
        saveSettings();
        
        // Auto-switch API type based on model
        if (isGeminiModel(e.target.value)) {
            document.getElementById('iig_api_type').value = 'gemini';
            settings.apiType = 'gemini';
            document.getElementById('iig_avatar_section')?.classList.remove('hidden');
        }
    });
    
    // Refresh models
    document.getElementById('iig_refresh_models')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const models = await fetchModels();
            const select = document.getElementById('iig_model');
            
            // Keep current selection if it exists in new list
            const currentModel = settings.model;
            
            select.innerHTML = '<option value="">-- Выберите модель --</option>';
            
            for (const model of models) {
                const option = document.createElement('option');
                option.value = model;
                option.textContent = model;
                option.selected = model === currentModel;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено моделей: ${models.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки моделей', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Size
    document.getElementById('iig_size')?.addEventListener('change', (e) => {
        settings.size = e.target.value;
        saveSettings();
    });
    
    // Quality
    document.getElementById('iig_quality')?.addEventListener('change', (e) => {
        settings.quality = e.target.value;
        saveSettings();
    });
    
    // Aspect Ratio (nano-banana)
    document.getElementById('iig_aspect_ratio')?.addEventListener('change', (e) => {
        settings.aspectRatio = e.target.value;
        saveSettings();
    });
    
    // Image Size (nano-banana)
    document.getElementById('iig_image_size')?.addEventListener('change', (e) => {
        settings.imageSize = e.target.value;
        saveSettings();
    });
    
    // Send char avatar
    document.getElementById('iig_send_char_avatar')?.addEventListener('change', (e) => {
        settings.sendCharAvatar = e.target.checked;
        saveSettings();
    });
    
    // Send user avatar
    document.getElementById('iig_send_user_avatar')?.addEventListener('change', (e) => {
        settings.sendUserAvatar = e.target.checked;
        saveSettings();
        
        // Show/hide avatar selection row
        const avatarRow = document.getElementById('iig_user_avatar_row');
        if (avatarRow) {
            avatarRow.classList.toggle('hidden', !e.target.checked);
        }
    });
    
    // User avatar file selection
    document.getElementById('iig_user_avatar_file')?.addEventListener('change', (e) => {
        settings.userAvatarFile = e.target.value;
        saveSettings();
    });
    
    // Refresh user avatars list
    document.getElementById('iig_refresh_avatars')?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.classList.add('loading');
        
        try {
            const avatars = await fetchUserAvatars();
            const select = document.getElementById('iig_user_avatar_file');
            const currentAvatar = settings.userAvatarFile;
            
            select.innerHTML = '<option value="">-- Не выбран --</option>';
            
            for (const avatar of avatars) {
                const option = document.createElement('option');
                option.value = avatar;
                option.textContent = avatar;
                option.selected = avatar === currentAvatar;
                select.appendChild(option);
            }
            
            toastr.success(`Найдено аватаров: ${avatars.length}`, 'Генерация картинок');
        } catch (error) {
            toastr.error('Ошибка загрузки аватаров', 'Генерация картинок');
        } finally {
            btn.classList.remove('loading');
        }
    });
    
    // Max retries
    document.getElementById('iig_max_retries')?.addEventListener('input', (e) => {
        settings.maxRetries = parseInt(e.target.value) || 3;
        saveSettings();
    });
    
    // Retry delay
    document.getElementById('iig_retry_delay')?.addEventListener('input', (e) => {
        settings.retryDelay = parseInt(e.target.value) || 1000;
        saveSettings();
    });
    
    // Export logs
    document.getElementById('iig_export_logs')?.addEventListener('click', () => {
        exportLogs();
    });
    
    // === NEW SETTINGS HANDLERS ===
    
    // Positive prompt
    document.getElementById('iig_positive_prompt')?.addEventListener('input', (e) => {
        const s = getSettings();
        s.positivePrompt = e.target.value;
        iigLog('INFO', `Positive prompt updated: "${e.target.value.substring(0, 30)}..."`);
        saveSettings();
    });
    
    // Negative prompt
    document.getElementById('iig_negative_prompt')?.addEventListener('input', (e) => {
        const s = getSettings();
        s.negativePrompt = e.target.value;
        iigLog('INFO', `Negative prompt updated: "${e.target.value.substring(0, 30)}..."`);
        saveSettings();
    });
    
    // Fixed style enabled toggle
    document.getElementById('iig_fixed_style_enabled')?.addEventListener('change', (e) => {
        const s = getSettings();
        s.fixedStyleEnabled = e.target.checked;
        iigLog('INFO', `Fixed style enabled: ${e.target.checked}`);
        saveSettings();
        if (e.target.checked && s.fixedStyle) {
            toastr.info(`Фиксированный стиль активен: ${s.fixedStyle}`, 'Генерация картинок');
        }
    });
    
    // Fixed style text
    document.getElementById('iig_fixed_style')?.addEventListener('input', (e) => {
        const s = getSettings();
        s.fixedStyle = e.target.value;
        iigLog('INFO', `Fixed style updated: "${e.target.value.substring(0, 30)}..."`);
        saveSettings();
    });
    
    // Extract appearance toggle
    document.getElementById('iig_extract_appearance')?.addEventListener('change', (e) => {
        const s = getSettings();
        s.extractAppearance = e.target.checked;
        iigLog('INFO', `Extract char appearance: ${e.target.checked}`);
        saveSettings();
    });
    
    // Extract user appearance toggle
    document.getElementById('iig_extract_user_appearance')?.addEventListener('change', (e) => {
        const s = getSettings();
        s.extractUserAppearance = e.target.checked;
        iigLog('INFO', `Extract user appearance: ${e.target.checked}`);
        saveSettings();
    });
    
    // Detect clothing toggle
    document.getElementById('iig_detect_clothing')?.addEventListener('change', (e) => {
        const s = getSettings();
        s.detectClothing = e.target.checked;
        iigLog('INFO', `Detect clothing: ${e.target.checked}`);
        saveSettings();
    });
    
    // Clothing search depth
    document.getElementById('iig_clothing_depth')?.addEventListener('input', (e) => {
        const s = getSettings();
        s.clothingSearchDepth = parseInt(e.target.value) || 5;
        iigLog('INFO', `Clothing depth: ${s.clothingSearchDepth}`);
        saveSettings();
    });
}

/**
 * Initialize extension
 */
(function init() {
    const context = SillyTavern.getContext();
    
    // Debug: log available event types
    console.log('[IIG] Available event_types:', context.event_types);
    console.log('[IIG] CHARACTER_MESSAGE_RENDERED:', context.event_types.CHARACTER_MESSAGE_RENDERED);
    console.log('[IIG] MESSAGE_SWIPED:', context.event_types.MESSAGE_SWIPED);
    
    // Load settings
    getSettings();
    
    // Create settings UI when app is ready
    context.eventSource.on(context.event_types.APP_READY, () => {
        createSettingsUI();
        // Add buttons to any messages already in chat
        addButtonsToExistingMessages();
        console.log('[IIG] Inline Image Generation extension loaded');
    });
    
    // When chat is loaded/changed, add buttons to all existing messages
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        iigLog('INFO', 'CHAT_CHANGED event - adding buttons to existing messages');
        // Small delay to ensure DOM is ready
        setTimeout(() => {
            addButtonsToExistingMessages();
        }, 100);
    });
    
    // Wrapper to add debug logging
    const handleMessage = async (messageId) => {
        console.log('[IIG] Event triggered for message:', messageId);
        await onMessageReceived(messageId);
    };
    
    // Listen for new messages AFTER they're rendered in DOM
    // CHARACTER_MESSAGE_RENDERED fires after addOneMessage() completes
    // This is the ONLY event we handle - no auto-retry on swipe/update
    context.eventSource.makeLast(context.event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    
    // NOTE: We intentionally DO NOT handle MESSAGE_SWIPED or MESSAGE_UPDATED
    // Swipe = user wants NEW content, not to retry old error images
    // If user wants to retry failed images, they use the regenerate button in menu
    
    console.log('[IIG] Inline Image Generation extension initialized');
})();
