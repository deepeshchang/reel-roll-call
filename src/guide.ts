// The groups' commenting guide: comments must be content-related and contain 2 words + 1 emoji.
// Avoid: "Nice ❤️", "Wow 🔥", "Amazing 😍", emoji only. `about` helps the AI tell the categories apart.

export interface GuideEntry {
    category: string;
    about: string;
    phrases: string[];
}

export const COMMENT_GUIDE: GuideEntry[] = [
    { category: 'Editing Reels', about: 'edits, transitions, effects', phrases: ['Smooth Editing 🔥', 'Perfect Transitions ✨', 'Clean Cuts 👏'] },
    { category: 'Photography / Aesthetic', about: 'scenery, nature, aesthetic shots', phrases: ['Beautiful Capture 📸', 'Lovely Colors 🌈', 'Stunning View 🌿'] },
    {
        category: 'Fashion / Outfit',
        about: 'outfits, clothes, makeup, styling, products',
        phrases: ['Gorgeous Outfit 👗', 'Elegant Style ✨', 'Beautiful Look 🌸', 'Outfit Link 🔗', 'Product Link 🛍️', 'Link Please 🔗'],
    },
    { category: 'Confidence / Personality', about: 'a person talking, dancing, posing or acting on camera', phrases: ['Great Confidence 💯', 'Positive Energy ⚡', 'Strong Presence 👑'] },
    { category: 'Creative / Art', about: 'art, drawing, crafts, creative ideas', phrases: ['Creative Concept 💡', 'Unique Idea 🌟', 'Amazing Creativity 🎨'] },
    {
        category: 'Lifestyle / Vlogs',
        about: 'daily life, family, kids, travel, places',
        phrases: ['Lovely Moments 🥰', 'Beautiful Vibes 💖', 'Great Memories 🌷', 'Location Please 📍', 'Exact Location 📌'],
    },
    { category: 'Food Content', about: 'food, cooking, restaurants', phrases: ['Delicious Treat 😋', 'Yummy Dish 🍽️', 'Tasty Creation 🤤', 'Location Please 📍', 'Food Location 🍴'] },
];

// ponytail: for a reel whose content could not be judged (no AI, or it failed) - the guide's most general phrases.
export const GENERAL = ['Beautiful Vibes 💖', 'Positive Energy ⚡', 'Lovely Moments 🥰'];

/** A phrase at random - not one of the `recent` ones, when there is a choice. */
export function pickPhrase(phrases: string[], recent: string[]): string {
    const fresh = phrases.filter(phrase => !recent.includes(phrase));
    const pool = fresh.length ? fresh : phrases;
    return pool[Math.floor(Math.random() * pool.length)];
}

export function guidePhrase(entry: GuideEntry | undefined, recent: string[]): string {
    return pickPhrase(entry?.phrases ?? GENERAL, recent);
}
