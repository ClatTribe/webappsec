'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';

// Visible "Search" button in the sidebar. Acts as a discovery aid
// for users who don't know about ⌘K yet — clicking it dispatches the
// same custom event the keyboard shortcut listens for.
//
// We use a custom event ('tensorshield:open-palette') instead of
// hoisting state because the trigger lives in the sidebar (server-
// rendered tree) and the palette modal lives at the layout root
// (separate React tree). A custom event is the cleanest
// cross-tree signal without a context provider.

export default function CommandPaletteTrigger() {
  // Detect platform for the kbd hint — ⌘ on macOS, Ctrl on others.
  // Hydration-safe: render the generic "K" until mount completes,
  // then upgrade to the platform-specific glyph.
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(new CustomEvent('tensorshield:open-palette'));
      }}
      className="group mx-3 mt-3 flex w-[calc(100%-1.5rem)] items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-1.5 text-left text-xs text-neutral-500 transition-colors hover:border-neutral-700 hover:bg-neutral-900/80 hover:text-neutral-300"
      aria-label="Open command palette"
    >
      <Search className="h-3.5 w-3.5" strokeWidth={2.25} />
      <span className="flex-1">Search…</span>
      <kbd className="rounded border border-neutral-800 bg-neutral-950 px-1.5 py-0.5 font-mono text-[9px] text-neutral-500">
        {isMac ? '⌘' : 'Ctrl'} K
      </kbd>
    </button>
  );
}
