import { buildActions, type LunaUnload, reduxStore, Tracer } from "@luna/core";
import { MediaItem, observe, redux, safeTimeout, StyleTag } from "@luna/lib";
import { OverlayScrollbars } from "overlayscrollbars";

import styles from "file://styles.css?minify";
import {
	collapseBlankLines,
	fetchGeniusLyrics,
	type AnnotatedSegment,
	type GeniusResult,
	type LyricLine,
} from "./genius";
import { fetchAnnotationNote, type AnnotationNote } from "./genius.annotations";
import { Settings, settings } from "./Settings";

export const { trace } = Tracer("[Genius Lyrics]");
export { Settings };

// Functions in unloads run when the plugin is unloaded — used to clean up
// injected DOM, listeners, and styles.
export const unloads = new Set<LunaUnload>();

new StyleTag("GeniusLyrics", unloads, styles);

const toastErr = (message: string): void => {
	reduxStore.dispatch(
		buildActions["message/MESSAGE_ERROR"]?.({
			message,
			category: "OTHER",
			severity: "ERROR",
		}),
	);
};

// --- Current track -----------------------------------------------------------

interface TrackInfo {
	trackId: string;
	title: string;
	artist: string;
}

/** All credited artist names (primary + featured), main artist first —
 * needed so the Genius matcher can give credit for a featured artist too,
 * not just the primary one. A track's primary-only `item.artist?.name` loses
 * featured artists entirely, which matters when a song has same-titled
 * "volumes" in a series distinguished only by which artists are featured on
 * each (see genius.ts's pickBestHit). */
const getArtistNames = (artists: unknown): string[] => {
	if (!Array.isArray(artists)) return [];
	return artists
		.slice()
		.sort((a: any, b: any) => Number(b?.main) - Number(a?.main))
		.map((a: any) => a?.name)
		.filter((n): n is string => Boolean(n));
};

const getTrackInfo = async (): Promise<TrackInfo | null> => {
	const mi = await MediaItem.fromPlaybackContext();
	const item = mi?.tidalItem as any;
	if (!item) return null;

	const baseTitle: string = item.title ?? "";
	// Include the version (e.g. "Remix") so search matches the right cut.
	const title = item.version ? `${baseTitle} (${item.version})` : baseTitle;
	const artistNames = getArtistNames(item.artists);
	const artist: string =
		artistNames.length ? artistNames.join(", ") : item.artist?.name ?? "";
	const trackId = String(item.id ?? "");

	if (!baseTitle || !artist) return null;
	return { trackId, title, artist };
};

// --- TIDAL's now-playing panel state -----------------------------------------
//
// TIDAL drives which now-playing tab is shown (Lyrics/Credits/Similar tracks,
// or none/collapsed) through a single redux value: settings.nowPlayingActiveView
// (null when collapsed, otherwise a view name). The native tab buttons derive
// their pressed/active styling FROM this value — it is the single source of
// truth, not local per-button state.
//
// We piggy-back on it with our own view name. Setting it to our name:
//   - keeps the panel wrapper mounted/open (no collapse animation),
//   - causes React to unmount whatever native panel was showing (none of its
//     views match our name), leaving the content slot empty for us to fill,
//   - causes every native tab to un-press itself automatically (none of them
//     match our view name either).
// This eliminates the flashing/race bugs from the earlier approach, which
// tried to fake this by clicking native tab DOM nodes directly.
const GENIUS_VIEW = "luna-genius-lyrics";

const getActiveView = (): string | null =>
	(redux.store.getState() as any)?.settings?.nowPlayingActiveView ?? null;

// NOTE: redux.actions[...] dispatches via the raw action creator directly
// (reduxStore.dispatch(buildAction(...))) — it does NOT go through the
// interceptor proxy that `redux.intercept` taps into (that proxy only wraps
// the action-creator instance TIDAL's own UI code obtains internally). So our
// own dispatches never trigger our own intercept callback; we must sync
// manually here. `redux.intercept` below is still useful for the opposite
// direction — reacting when the user clicks a *native* tab.
const setActiveView = (view: string | null): void => {
	const action = (redux.actions as any)["settings/SET_NOW_PLAYING_ACTIVE_VIEW"] as
		| ((next: string | null) => unknown)
		| undefined;
	action?.(view);
	scheduleSync(view);
};

// --- DOM anchors --------------------------------------------------------------

const TAB_CLASS = "genius-lyrics-tab";
const CONTENT_CLASS = "genius-lyrics-content";

const NATIVE_TAB_SELECTOR =
	'[data-test="toggle-lyrics"], [data-test="toggle-credits"], [data-test="toggle-similar-tracks"]';
// The content slot React swaps native panels into. Scoped under the stable
// `new-now-playing` section since the slot itself has no data-test attribute.
const CONTENT_SLOT_SELECTOR = '[data-test="new-now-playing"] [class*="panelContent"]';

const getNativeTabs = (): HTMLElement[] =>
	Array.from(document.querySelectorAll<HTMLElement>(NATIVE_TAB_SELECTOR)).filter(
		(el) => !el.classList.contains(TAB_CLASS),
	);

const getGeniusTab = (): HTMLElement | null =>
	document.querySelector<HTMLElement>(`.${TAB_CLASS}`);

const isTabActive = (tab: HTMLElement): boolean =>
	tab.getAttribute("aria-pressed") === "true" ||
	tab.getAttribute("aria-selected") === "true";

const findContentSlot = (): HTMLElement | null =>
	document.querySelector<HTMLElement>(CONTENT_SLOT_SELECTOR);

// --- Active/inactive tab styling ---------------------------------------------
//
// TIDAL swaps a tab between an inactive CSS-module class ("_secondary_1l1bl_7")
// and an active one ("_primary_1l1bl_6") — additive toggling alone leaves both
// present and renders a broken half-state. Both classes come from the SAME CSS
// module (shared hash "1l1bl") and the "_primary_" rule already exists in the
// stylesheet whether or not it's currently applied to any element — so the
// active class can be derived directly from an inactive tab's class, with no
// need to ever observe a tab in its active state.
//
// IMPORTANT: that CSS module is a whole shared button-component kit, not a
// simple two-variant toggle — confirmed via live inspection it also defines
// "_tertiary_"/"_destructive_" (other button intents) and "_small_"/"_medium_"/
// "_large_" (sizes) under the SAME hash. Matching "any other class sharing the
// hash" is ambiguous (18+ candidates). Targeting the specific semantic word
// swap ("secondary" -> "primary" — this app's convention for unselected ->
// selected) is what makes the match unambiguous.
const SECONDARY_CLASS_RE = /^_secondary_([a-z0-9]+)_\d+$/;

/** Given a tab's "_secondary_HASH_n" class, find the "_primary_HASH_m" sibling
 * already defined in the stylesheet for that same module. */
const findPrimarySibling = (secondaryClass: string): string | null => {
	const match = secondaryClass.match(SECONDARY_CLASS_RE);
	if (!match) return null;
	const moduleHash = match[1];
	const primaryRe = new RegExp(`^_primary_${moduleHash}_\\d+$`);
	const found = new Set<string>();
	for (const sheet of Array.from(document.styleSheets)) {
		let rules: CSSRuleList;
		try {
			rules = sheet.cssRules;
		} catch {
			continue; // cross-origin stylesheet, inaccessible — skip
		}
		for (const rule of Array.from(rules)) {
			const selectorText = (rule as CSSStyleRule).selectorText;
			if (!selectorText) continue;
			for (const token of selectorText.split(/[\s.,>+~:]+/)) {
				if (primaryRe.test(token)) found.add(token);
			}
		}
	}
	// Only act when exactly one "_primary_" class exists for this module — an
	// ambiguous or empty match means the swap assumption doesn't hold here.
	return found.size === 1 ? [...found][0] : null;
};

let activeOnlyClasses: string[] = [];
let inactiveOnlyClasses: string[] = [];

const splitClasses = (el: HTMLElement): string[] =>
	el.className.split(/\s+/).filter(Boolean);

const learnVariantClasses = (): void => {
	if (activeOnlyClasses.length) return; // already known, nothing to do
	// Any "_secondary_" class is inherently the inactive variant in this app's
	// convention — no need to find a tab that's currently active at all.
	for (const tab of getNativeTabs()) {
		for (const cls of splitClasses(tab)) {
			const primary = findPrimarySibling(cls);
			if (!primary) continue;
			inactiveOnlyClasses = [cls];
			activeOnlyClasses = [primary];
			return;
		}
	}
};

const setTabActiveState = (tab: HTMLElement | null, active: boolean): void => {
	if (!tab) return;
	if (active) {
		for (const c of inactiveOnlyClasses) tab.classList.remove(c);
		for (const c of activeOnlyClasses) tab.classList.add(c);
	} else {
		for (const c of activeOnlyClasses) tab.classList.remove(c);
		for (const c of inactiveOnlyClasses) tab.classList.add(c);
	}
	tab.setAttribute("aria-pressed", active ? "true" : "false");
	tab.setAttribute("aria-selected", active ? "true" : "false");
};

// --- Genius content element --------------------------------------------------

// `contentEl` is the element we mount into TIDAL's panel content slot. It is
// also the OverlayScrollbars *target*: the library restructures its insides
// (host/viewport/content) the same way TIDAL's own scrollable panels (e.g. the
// native lyrics view) are structured, using TIDAL's already-loaded "os-theme-tidal"
// theme — so this panel's scrollbar matches every other scrollable area in the
// app instead of the browser's native one.
//
// Everything — lyrics text, then the divider + source line — lives inside that
// single scrollable flow (matching how radiant's lyrics view works: one
// scrollable container, no pinned/sticky footer). The source line simply
// scrolls past at the end of the lyrics rather than staying on screen.
let contentEl: HTMLElement | null = null;
let scrollbars: ReturnType<typeof OverlayScrollbars> | null = null;
let requestSeq = 0;
const lyricsCache = new Map<string, GeniusResult>();
const cacheKey = (info: TrackInfo): string => `${info.title}\0${info.artist}`;

// Where we actually write lyrics/source HTML — OverlayScrollbars moves a
// target's original children into an internally-created "content" element, so
// content inserted after init must go there, not into `contentEl` itself.
const getScrollContent = (): HTMLElement => scrollbars!.elements().content;

const applyFontScale = (): void => {
	contentEl?.style.setProperty("--gl-font-scale", String(settings.lyricsFontSize / 100));
};
window.updateGeniusLyricsFontSize = applyFontScale;
unloads.add(() => {
	delete window.updateGeniusLyricsFontSize;
});

const ensureContentEl = (): HTMLElement => {
	if (contentEl) return contentEl;
	const el = document.createElement("div");
	el.className = CONTENT_CLASS;
	contentEl = el;
	applyFontScale();

	scrollbars = OverlayScrollbars(el, {
		scrollbars: { theme: "os-theme-tidal", autoHide: "leave" },
	});
	getScrollContent().innerHTML = `
		<div class="gl-text"></div>
		<div class="gl-source-row"></div>
	`;

	unloads.add(() => {
		scrollbars?.destroy();
		scrollbars = null;
		el.remove();
		contentEl = null;
	});
	return el;
};

const mountContent = (): void => {
	const slot = findContentSlot();
	const el = ensureContentEl();
	if (slot && el.parentElement !== slot) slot.appendChild(el);
};

const unmountContent = (): void => {
	contentEl?.remove();
};

const setBody = (text: string, isEmpty: boolean): void => {
	ensureContentEl();
	const scrollContent = getScrollContent();
	const textEl = scrollContent.querySelector(".gl-text") as HTMLElement;
	textEl.textContent = text;
	textEl.classList.toggle("gl-empty", isEmpty);
	// Clear the source footer whenever we're showing a status message — the
	// previous song's "Source: Genius" link must not linger during loading or error.
	(scrollContent.querySelector(".gl-source-row") as HTMLElement).innerHTML = "";
	scrollbars!.elements().viewport.scrollTop = 0;
};

// --- Annotation popover --------------------------------------------------
//
// Notes are cached by referent ID (durable across replays of the same track,
// unlike lyricsCache which is keyed per-track) with a bounded FIFO eviction —
// a real LRU library would be overkill for a personal plugin caching a few
// hundred short HTML strings; a simple size cap is "engineered enough" here.
const ANNOTATION_CACHE_MAX = 500;
const annotationCache = new Map<string, AnnotationNote>();
let annotationRequestSeq = 0;

const cacheAnnotation = (id: string, note: AnnotationNote): void => {
	annotationCache.set(id, note);
	if (annotationCache.size > ANNOTATION_CACHE_MAX) {
		const oldest = annotationCache.keys().next().value;
		if (oldest !== undefined) annotationCache.delete(oldest);
	}
};

let openPopover: { id: string; trigger: HTMLElement; el: HTMLElement } | null = null;

// A single Genius annotation can span multiple lines — each line gets its own
// <button> (one segment per line-flush), but they all share the same
// annotationId. Hover/active treatment must apply to the whole group, not
// just whichever line's button the pointer/click happened to land on, or
// "all lines" of a multi-line annotation won't look like one clickable unit.
const getAnnotationButtons = (id: string): HTMLElement[] =>
	Array.from(
		getScrollContent().querySelectorAll<HTMLElement>(
			`.gl-annotation[data-annotation-id="${id}"]`,
		),
	);

const setGroupClass = (id: string, className: string, on: boolean): void => {
	for (const btn of getAnnotationButtons(id)) btn.classList.toggle(className, on);
};

const onDocumentClick = (e: MouseEvent): void => {
	if (!openPopover) return;
	const target = e.target as Node;
	if (openPopover.el.contains(target) || openPopover.trigger.contains(target)) return;
	closePopover(false);
};

const onDocumentKeydown = (e: KeyboardEvent): void => {
	if (!openPopover || e.key !== "Escape") return;
	e.preventDefault();
	closePopover(true);
};

const closePopover = (returnFocus: boolean): void => {
	if (!openPopover) return;
	const { id, trigger, el } = openPopover;
	el.remove();
	setGroupClass(id, "gl-annotation-active", false);
	for (const btn of getAnnotationButtons(id)) btn.setAttribute("aria-expanded", "false");
	openPopover = null;
	document.removeEventListener("click", onDocumentClick, true);
	document.removeEventListener("keydown", onDocumentKeydown, true);
	if (returnFocus) trigger.focus();
};

const setPopoverLoading = (el: HTMLElement): void => {
	el.classList.add("gl-annotation-loading");
	el.classList.remove("gl-annotation-error");
	el.textContent = "Loading…";
};

const setPopoverContent = (el: HTMLElement, note: AnnotationNote): void => {
	el.classList.remove("gl-annotation-loading", "gl-annotation-error");
	el.textContent = "";
	if (note.verified) {
		const badge = document.createElement("div");
		badge.className = "gl-annotation-verified";
		badge.textContent = "✓ Verified";
		el.appendChild(badge);
	}
	const body = document.createElement("div");
	// Safe: `note.html` is already sanitized through DOMPurify in
	// genius.annotations.ts before it ever reaches here — this is the one
	// place that boundary is trusted.
	body.innerHTML = note.html;
	el.appendChild(body);
};

const setPopoverError = (el: HTMLElement): void => {
	el.classList.remove("gl-annotation-loading");
	el.classList.add("gl-annotation-error");
	el.textContent = "Couldn't load this annotation.";
};

const openPopoverFor = async (trigger: HTMLElement, id: string): Promise<void> => {
	if (openPopover?.id === id) {
		closePopover(true);
		return;
	}
	closePopover(false);

	const buttons = getAnnotationButtons(id);
	const lineEl = trigger.closest(".gl-line");
	if (!lineEl) return;

	const el = document.createElement("div");
	el.className = "gl-annotation-popover";
	el.setAttribute("role", "dialog");
	el.tabIndex = -1;
	lineEl.insertAdjacentElement("afterend", el);

	setGroupClass(id, "gl-annotation-active", true);
	for (const btn of buttons) btn.setAttribute("aria-expanded", "true");
	openPopover = { id, trigger, el };
	document.addEventListener("click", onDocumentClick, true);
	document.addEventListener("keydown", onDocumentKeydown, true);
	el.focus();
	el.scrollIntoView({ block: "nearest" });

	const seq = ++annotationRequestSeq;
	const cached = annotationCache.get(id);
	if (cached !== undefined) {
		setPopoverContent(el, cached);
		return;
	}

	setPopoverLoading(el);
	try {
		const note = await fetchAnnotationNote(id);
		if (seq !== annotationRequestSeq || openPopover?.el !== el) return;
		cacheAnnotation(id, note);
		setPopoverContent(el, note);
		// The "Loading…" placeholder is much shorter than real content — once it
		// arrives the popover can grow well past what the initial scroll (above)
		// brought into view, so the bottom of it ends up below the fold. Re-align
		// now that its final height is known.
		el.scrollIntoView({ block: "nearest" });
	} catch (err) {
		if (seq !== annotationRequestSeq || openPopover?.el !== el) return;
		const message = err instanceof Error ? err.message : String(err);
		trace.err(`Annotation fetch failed: ${message}`);
		setPopoverError(el);
		el.scrollIntoView({ block: "nearest" });
	}
};

// A real <button> here inherits TIDAL's own global button reset (native
// appearance/rounded corners/inline-block wrapping behavior) — without
// devtools into the host app's renderer there's no reliable way to out-fight
// that via CSS specificity. A <span role="button"> carries none of that
// baggage, so it's the more robust choice for an inline annotation trigger;
// Enter/Space activation (free on a real button) is wired up manually below.
const createAnnotationButton = (segment: AnnotatedSegment): HTMLElement => {
	const btn = document.createElement("span");
	btn.setAttribute("role", "button");
	btn.tabIndex = 0;
	btn.className = "gl-annotation";
	btn.textContent = segment.text;
	btn.dataset.annotationId = segment.annotationId;
	btn.setAttribute("aria-expanded", "false");
	const activate = (e: Event): void => {
		e.stopPropagation();
		void openPopoverFor(btn, segment.annotationId);
	};
	btn.addEventListener("click", activate);
	btn.addEventListener("keydown", (e: KeyboardEvent) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault(); // Space must not also scroll the panel
		activate(e);
	});
	// A multi-line annotation has one trigger per line — hovering any of them
	// should highlight the whole group, not just the line under the pointer.
	btn.addEventListener("mouseenter", () =>
		setGroupClass(segment.annotationId, "gl-annotation-hover", true),
	);
	btn.addEventListener("mouseleave", () =>
		setGroupClass(segment.annotationId, "gl-annotation-hover", false),
	);
	return btn;
};

// --- Lyrics body rendering -----------------------------------------------
//
// Each actual Genius line becomes its own block element with margin between
// blocks (see .gl-line in styles.css). That margin is what makes "a new
// lyric line" visually bigger than "the same long line soft-wrapping" —
// soft-wrap continuation only gets the tighter line-height, since it happens
// *inside* one block, not between two of them.
//
// Section headers ("[Verse 1]", "[Chorus]", ...) get an extra class so CSS can
// style them distinctly (see .gl-section-header). Annotated fragments render
// as focusable <span role="button"> triggers (see createAnnotationButton
// above for why not a real <button>), one per fragment, unless the user has
// disabled annotation highlighting in Settings — in which case they render
// as plain text, fully non-interactive.
const setLyricsBody = (lines: LyricLine[]): void => {
	ensureContentEl();
	closePopover(false); // the DOM subtree it's anchored to is about to be wiped
	const scrollContent = getScrollContent();
	const textEl = scrollContent.querySelector(".gl-text") as HTMLElement;
	textEl.classList.remove("gl-empty");
	textEl.textContent = "";

	for (const line of lines) {
		const lineEl = document.createElement("div");
		if (line.kind === "header") {
			lineEl.className = "gl-line gl-section-header";
			lineEl.textContent = line.text;
		} else if (line.kind === "blank") {
			// Blank line (stanza break) — needs real content to hold its own
			// line-height worth of space, an empty div collapses to zero height.
			lineEl.className = "gl-line gl-blank";
			lineEl.innerHTML = "&nbsp;";
		} else {
			lineEl.className = "gl-line";
			for (const segment of line.segments) {
				if ("annotationId" in segment && !settings.hideAnnotationHighlighting) {
					lineEl.appendChild(createAnnotationButton(segment));
				} else {
					lineEl.appendChild(document.createTextNode(segment.text));
				}
			}
		}
		textEl.appendChild(lineEl);
	}

	scrollbars!.elements().viewport.scrollTop = 0;
};

const renderResult = (result: GeniusResult): void => {
	ensureContentEl();
	const sourceRow = getScrollContent().querySelector(".gl-source-row") as HTMLElement;
	sourceRow.innerHTML = "";

	if (!result.lyrics) {
		setBody("No lyrics found on Genius for this track.", true);
		return;
	}

	let lines = result.lyrics;
	if (settings.hideSectionHeaders) {
		lines = collapseBlankLines(lines.filter((l) => l.kind !== "header"));
	}
	setLyricsBody(lines);

	if (result.sourceUrl) {
		const link = document.createElement("a");
		link.className = "gl-source";
		link.textContent = `Source: ${result.sourceTitle ?? "Genius"}`;
		const url = result.sourceUrl;
		link.addEventListener("click", () => window.open(url, "_blank"));
		sourceRow.appendChild(link);
	}
};

const loadLyrics = async (force: boolean): Promise<void> => {
	const info = await getTrackInfo();
	if (!info) {
		setBody("No track is playing.", true);
		return;
	}

	const key = cacheKey(info);
	if (!force && lyricsCache.has(key)) {
		renderResult(lyricsCache.get(key)!);
		return;
	}

	setBody("Fetching lyrics from Genius…", true);
	const reqId = ++requestSeq;

	try {
		const result = await fetchGeniusLyrics(info.title, info.artist);
		if (reqId !== requestSeq || getActiveView() !== GENIUS_VIEW) return;
		lyricsCache.set(key, result);
		renderResult(result);
	} catch (err) {
		if (reqId !== requestSeq) return;
		const message = err instanceof Error ? err.message : String(err);
		setBody(`Error fetching lyrics: ${message}`, true);
		trace.err(`Fetch failed: ${message}`);
	}
};

// --- Reactive sync: one redux value drives everything ------------------------

const syncToView = (view: string | null): void => {
	const isGenius = view === GENIUS_VIEW;
	// Learn FIRST, before applying — the synchronous call happens while React
	// hasn't yet re-rendered, so a previously-active native tab may still carry
	// its active classes in the DOM at this exact moment.
	learnVariantClasses();
	setTabActiveState(getGeniusTab(), isGenius);

	if (isGenius) {
		mountContent();
		void loadLyrics(false);
	} else {
		unmountContent();
	}
};

// React re-renders (mounting the panel content slot, updating native tab
// classes) asynchronously after the redux state change — never synchronously
// inline with the dispatch. Sync immediately for the DOM we fully own (so the
// UI never looks unresponsive), then re-sync after a couple of delays to pick
// up the now-rendered content slot and freshly-updated native tab classes.
const scheduleSync = (view: string | null): void => {
	syncToView(view);
	safeTimeout(unloads, () => syncToView(getActiveView()), 60);
	safeTimeout(unloads, () => syncToView(getActiveView()), 250);
};

(redux.intercept as any)(
	"settings/SET_NOW_PLAYING_ACTIVE_VIEW",
	unloads,
	(view: string | null) => scheduleSync(view ?? null),
);

// --- Tab injection ------------------------------------------------------------

// Replace the first text node in a cloned tab with our label, preserving the
// surrounding element/class structure that drives the tab's styling.
const setTabLabel = (tab: HTMLElement, label: string): void => {
	const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
	const textNode = walker.nextNode();
	if (textNode) textNode.nodeValue = label;
	else tab.textContent = label;
};

const injectTab = (): void => {
	if (getGeniusTab()) return;
	const tabs = getNativeTabs();
	const anchor = tabs[0];
	if (!anchor?.parentElement) return;

	learnVariantClasses();

	// Clone an inactive native tab so we inherit the inactive variant by default.
	const inactiveSource = tabs.find((t) => !isTabActive(t)) ?? anchor;
	const tab = inactiveSource.cloneNode(true) as HTMLElement;
	tab.classList.add(TAB_CLASS);
	tab.removeAttribute("data-test");
	tab.removeAttribute("id");
	tab.setAttribute("aria-disabled", "false");
	tab.setAttribute("title", "Genius");
	setTabLabel(tab, "Genius");
	setTabActiveState(tab, getActiveView() === GENIUS_VIEW);

	tab.addEventListener("click", (e) => {
		e.stopPropagation();
		// Mirror native behaviour: clicking the already-active tab collapses the
		// panel; otherwise it switches the view to ours.
		setActiveView(getActiveView() === GENIUS_VIEW ? null : GENIUS_VIEW);
	});

	anchor.parentElement.appendChild(tab);
};

// (Re)inject the tab whenever the now-playing tab bar (re)appears, and bring it
// in sync with whatever view is currently active (e.g. after a remount caused
// by a track change while Genius was open).
observe<HTMLElement>(unloads, NATIVE_TAB_SELECTOR, () => {
	injectTab();
	syncToView(getActiveView());
});

// Refresh lyrics when the track changes while the Genius view is active.
// The popover always closes on track change (regardless of autoRefetchOnTrackChange)
// — leaving the old track's annotation open over a new track's lyrics would be
// exactly the staleness this guards against, independent of whether lyrics refetch.
MediaItem.onMediaTransition(unloads, async () => {
	if (getActiveView() !== GENIUS_VIEW) return;
	closePopover(false);
	if (!settings.autoRefetchOnTrackChange) return;
	safeTimeout(
		unloads,
		() => {
			if (getActiveView() !== GENIUS_VIEW) return;
			mountContent();
			void loadLyrics(false);
		},
		300,
	);
});

unloads.add(() => {
	closePopover(false);
	getGeniusTab()?.remove();
	// Leave nowPlayingActiveView alone on unload if it's ours — collapsing the
	// panel out from under the user on a routine plugin reload would be
	// surprising; the (now tab-less) view will just render no panel content.
});
