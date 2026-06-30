// Render-side Genius client: search, scrape, and clean.
// Network fetches are delegated to ./genius.native (main process, no CORS).
// HTML parsing happens here because DOMParser is a render/browser API.
//
// Search + scrape strategy and the title-cleanup helpers are ported from
// spicetify/cli's CustomApps/lyrics-plus (ProviderGenius.js + Utils.js).

import { Tracer } from "@luna/core";

import { extractAnnotationId, isValidAnnotationId } from "./genius.annotations";
import { geniusFetchPage, geniusSearch } from "./genius.native";

export const { trace } = Tracer("[Genius Lyrics]");

export interface GeniusHit {
	title: string;
	url: string;
	primaryArtist: string;
	/** Featured/collaborating artists, separate from primaryArtist — needed to
	 * disambiguate same-titled hits that differ only in who's featured (see
	 * pickBestHit). */
	featuredArtists: string[];
	instrumental: boolean;
}

// --- Lyric line segment model -------------------------------------------------
//
// Each Genius lyric line is modeled as typed data, not a flattened string — this
// preserves which fragments are annotated (and their referent IDs) so the render
// layer can build real clickable DOM nodes per fragment, instead of trusting raw
// remote HTML via innerHTML. See the V2 design doc for the full rationale.

export interface PlainSegment {
	text: string;
}
export interface AnnotatedSegment {
	text: string;
	annotationId: string;
}
export type Segment = PlainSegment | AnnotatedSegment;

export type LyricLine =
	| { kind: "header"; text: string }
	| { kind: "blank" }
	| { kind: "text"; segments: Segment[] };

export interface GeniusResult {
	lyrics: LyricLine[] | null;
	hits: GeniusHit[];
	sourceUrl?: string;
	sourceTitle?: string;
}

// --- Title cleanup (ported from lyrics-plus Utils) ---------------------------

/** "Song - Remastered 2011" -> "Song" */
const removeExtraInfo = (s: string): string => s.replace(/\s-\s.*/, "");

/** Strip "feat."/"with"/"prod." segments in both "- feat" and "(feat ...)" forms */
const removeSongFeat = (s: string): string =>
	s
		.replace(/-\s+(feat|with|prod).*/i, "")
		.replace(/(\(|\[)(feat|with|prod)\.?\s+.*(\)|\])$/i, "")
		.trim() || s;

/** Ordered, de-duplicated set of title variants to try against Genius search. */
const titleVariants = (title: string): string[] => {
	const noExtra = removeExtraInfo(title);
	const variants = [
		title,
		noExtra,
		removeSongFeat(title),
		removeSongFeat(noExtra),
	];
	return [...new Set(variants)].filter((t) => t.trim().length > 0);
};

// --- HTML -> segment model ---------------------------------------------------

const SECTION_HEADER_RE = /^\[.*\]$/;

/** Drop a segment if it has no text AND no annotation — but never drop an
 * annotated segment just because its text trimmed to empty (rare, but losing
 * the click target entirely would be worse than an empty-looking clickable span). */
const isEmptySegment = (s: Segment): boolean => s.text.length === 0 && !("annotationId" in s);

/** Trim leading whitespace off the first segment and trailing whitespace off the
 * last, then drop any segment left empty by that — mirrors the old cleanLyrics'
 * per-line .trim(), just operating on segments instead of a flat string. */
const trimLineSegments = (segments: Segment[]): Segment[] => {
	if (!segments.length) return segments;
	const trimmed = segments.map((s, i) => {
		let text = s.text;
		if (i === 0) text = text.replace(/^\s+/, "");
		if (i === segments.length - 1) text = text.replace(/\s+$/, "");
		return { ...s, text };
	});
	return trimmed.filter((s) => !isEmptySegment(s));
};

const classifyLine = (segments: Segment[]): LyricLine => {
	const trimmed = trimLineSegments(segments);
	const fullText = trimmed.map((s) => s.text).join("");
	if (SECTION_HEADER_RE.test(fullText)) {
		return { kind: "header", text: fullText.replace(/^\[|\]$/g, "") };
	}
	if (fullText.trim().length === 0) return { kind: "blank" };
	return { kind: "text", segments: trimmed };
};

/**
 * Parse the innerHTML of a Genius `[data-lyrics-container]` into typed lines.
 * Genius uses `<br>` for line breaks and wraps annotated fragments in `<a>` tags
 * carrying a referent ID (confirmed against live genius.com markup during the V2
 * spike). A single annotation can span MULTIPLE lines — `<br>` tags can appear
 * *inside* the anchor, not only between annotation spans — so `<br>` always
 * flushes a line regardless of nesting depth, while the current annotation id is
 * carried as context through that flush.
 *
 * The first container is often prefixed with a `LyricsHeader` block (the
 * contributor count, translation language list, song description "Read
 * More" blurb) — not lyrics. Genius marks it `data-exclude-from-selection`
 * (their own "this isn't selectable lyrics text" signal), so we strip any
 * element carrying that attribute before walking.
 */
const parseLyricsContainer = (fragmentHtml: string): LyricLine[] => {
	const doc = new DOMParser().parseFromString(
		`<div id="gl-root">${fragmentHtml}</div>`,
		"text/html",
	);
	const root = doc.getElementById("gl-root");
	if (!root) return [];
	for (const excluded of Array.from(
		root.querySelectorAll('[data-exclude-from-selection="true"]'),
	)) {
		excluded.remove();
	}

	const lines: LyricLine[] = [];
	let current: Segment[] = [];

	const pushText = (text: string, annotationId: string | null): void => {
		if (!text) return;
		current.push(annotationId ? { text, annotationId } : { text });
	};

	const flush = (): void => {
		lines.push(classifyLine(current));
		current = [];
	};

	const walk = (node: ChildNode, annotationId: string | null): void => {
		if (node.nodeType === Node.TEXT_NODE) {
			pushText(node.textContent ?? "", annotationId);
			return;
		}
		if (node.nodeName === "BR") {
			flush();
			return;
		}
		if (node.nodeName === "A") {
			const anchor = node as HTMLAnchorElement;
			const extracted = extractAnnotationId(anchor);
			// Genius's own zero-size accessibility decoy spans (empty,
			// tabindex="0") are plain <span>s, not <a>s, so they fall through to
			// the generic recursion below and naturally contribute nothing.
			const id = extracted && isValidAnnotationId(extracted) ? extracted : annotationId;
			for (const child of Array.from(node.childNodes)) walk(child, id);
			return;
		}
		for (const child of Array.from(node.childNodes)) walk(child, annotationId);
	};

	for (const child of Array.from(root.childNodes)) walk(child, null);
	flush(); // trailing content with no closing <br>

	return lines;
};

/** Collapse consecutive blank lines to one, and trim leading/trailing blanks —
 * the segment-model equivalent of the old flat-string cleanLyrics' blank-run
 * collapse and outer .trim(). Exported: index.ts reuses this when re-collapsing
 * after filtering out header lines for the hideSectionHeaders setting. */
export const collapseBlankLines = (lines: LyricLine[]): LyricLine[] => {
	const result: LyricLine[] = [];
	for (const line of lines) {
		if (line.kind === "blank" && result.at(-1)?.kind === "blank") continue;
		result.push(line);
	}
	while (result[0]?.kind === "blank") result.shift();
	while (result.at(-1)?.kind === "blank") result.pop();
	return result;
};

const extractLyricsFromPage = (html: string): LyricLine[] | null => {
	const doc = new DOMParser().parseFromString(html, "text/html");
	const containers = doc.querySelectorAll('div[data-lyrics-container="true"]');
	if (!containers.length) return null;

	let combined: LyricLine[] = [];
	for (const container of Array.from(containers)) {
		if (combined.length) combined.push({ kind: "blank" });
		combined = combined.concat(parseLyricsContainer(container.innerHTML));
	}
	const cleaned = collapseBlankLines(combined);
	return cleaned.length ? cleaned : null;
};

// --- Search ------------------------------------------------------------------

const search = async (artist: string, title: string): Promise<GeniusHit[]> => {
	const raw = await geniusSearch(`${artist} ${title}`);
	let json: any;
	try {
		json = JSON.parse(raw);
	} catch {
		trace.log("Genius search returned non-JSON payload");
		return [];
	}

	const hits: any[] = json?.response?.sections?.[0]?.hits ?? [];
	return hits
		.map((hit) => {
			const result = hit?.result;
			const featuredArtists: unknown[] = result?.featured_artists ?? [];
			return {
				title: result?.full_title as string | undefined,
				url: result?.url as string | undefined,
				primaryArtist: (result?.primary_artist_names ??
					result?.primary_artist?.name ??
					"") as string,
				featuredArtists: featuredArtists
					.map((a: any) => a?.name)
					.filter((n): n is string => Boolean(n)),
				instrumental: Boolean(result?.instrumental),
			};
		})
		.filter((hit): hit is GeniusHit => Boolean(hit.title && hit.url));
};

// --- Matching -----------------------------------------------------------------
//
// Genius's relevance ranking frequently puts "Genius <Language> Translations"
// curator pages (Türkçe Çeviri, Traducción al Español, etc.) above the actual
// song page, because their titles repeat the query closely. Naively taking
// hits[0] picks a translated page more often than not. We verify the artist
// instead of trusting result order.

const stripDiacritics = (s: string): string =>
	s.normalize("NFKD").replace(/[̀-ͯ]/g, "");

const normalize = (s: string): string =>
	stripDiacritics(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();

// Genius's translation/cover curator accounts are themselves credited as the
// "artist" (e.g. "Genius Türkçe Çeviriler", "Genius Traducciones al Español",
// "Genius Brasil Traduções") — never the real recording artist. Matching on
// the word "genius" plus a translation-ish keyword catches them across the
// languages Genius actually publishes curator pages in.
const TRANSLATION_CURATOR_RE =
	/\bgenius\b.*\b(translat|tradu|ceviri|ceviriler|perevod|tlumacz|vertal|kaannos|oversaet|fordit|kaanos)/;

const looksLikeTranslationOrCover = (primaryArtist: string): boolean =>
	TRANSLATION_CURATOR_RE.test(normalize(primaryArtist));

// A bare token-overlap check ("does any requested artist word appear in the
// hit's credit") can't be trusted as a yes/no gate: a single-word artist name
// like "Joy" is a complete, literal substring of a totally unrelated "Big Joy"
// just as much as it is of the correct "Joy (Solo)" — both score identically
// under pure overlap, no threshold fixes that. What actually distinguishes
// them is word ORDER: a real alias/qualifier ("Joy (Solo)") extends the
// requested name at the end, while an unrelated same-ish-named act ("Big Joy")
// prepends something different at the start. Requiring the hit's primary
// artist to start with the requested primary artist (or vice versa, for the
// rarer case Genius credits a shorter solo name than requested) catches that.
const primaryArtistMatches = (requestedPrimary: string, hitPrimary: string): boolean => {
	const reqNorm = normalize(requestedPrimary);
	if (!reqNorm) return true;
	const hitNorm = normalize(hitPrimary);
	const reqTokens = reqNorm.split(" ");
	const hitTokens = hitNorm.split(" ");
	return (
		hitTokens.slice(0, reqTokens.length).join(" ") === reqNorm ||
		reqTokens.slice(0, hitTokens.length).join(" ") === hitNorm
	);
};

/** Fraction (0-1) of the requested artist's distinct name tokens that appear
 * in the hit's combined primary+featured credit. Used only to RANK hits that
 * already passed primaryArtistMatches — two hits can share the exact same
 * primary artist and near-identical title (e.g. a recurring "Vol. N"
 * freestyle series by one MC with a different guest each volume), and only
 * the featured-artist credit tells them apart. */
const artistMatchScore = (requestedArtist: string, hit: GeniusHit): number => {
	const reqTokens = normalize(requestedArtist)
		.split(" ")
		.filter((t) => t.length > 1);
	if (!reqTokens.length) return 1;
	const hitNorm = normalize([hit.primaryArtist, ...hit.featuredArtists].join(" "));
	const matched = reqTokens.filter((t) => hitNorm.includes(t)).length;
	return matched / reqTokens.length;
};

/** Pick the best-matching hit for the requested artist, or null if none have
 * a plausibly-matching primary artist — better to report no lyrics than to
 * confidently show the wrong song. `artist` is the full credit list, primary
 * artist first (see index.ts's getArtistNames). */
const pickBestHit = (artist: string, hits: GeniusHit[]): GeniusHit | null => {
	const requestedPrimary = artist.split(",")[0]?.trim() ?? "";
	const candidates = hits.filter(
		(h) =>
			!h.instrumental &&
			!looksLikeTranslationOrCover(h.primaryArtist) &&
			primaryArtistMatches(requestedPrimary, h.primaryArtist),
	);
	if (!candidates.length) return null;
	let best = candidates[0];
	let bestScore = artistMatchScore(artist, best);
	for (const candidate of candidates.slice(1)) {
		const score = artistMatchScore(artist, candidate);
		if (score > bestScore) {
			best = candidate;
			bestScore = score;
		}
	}
	return best;
};

// --- Public API --------------------------------------------------------------

/**
 * Look up lyrics for a track on Genius. Tries progressively cleaner title
 * variants, verifying the artist on each variant's results (rejecting
 * translation/cover curator pages) before falling through to the next.
 */
export const fetchGeniusLyrics = async (
	title: string,
	artist: string,
): Promise<GeniusResult> => {
	let allHits: GeniusHit[] = [];
	let best: GeniusHit | null = null;

	for (const variant of titleVariants(title)) {
		const hits = await search(artist, variant);
		if (!hits.length) continue;
		if (!allHits.length) allHits = hits;

		best = pickBestHit(artist, hits);
		if (best) break;
	}

	if (!best) {
		if (!allHits.length) {
			trace.log(`No Genius hits for "${title}" by "${artist}"`);
		} else {
			// Deliberately do NOT fall back to allHits[0] here — Genius's search
			// can rank an unrelated same-ish-named artist's song above the real
			// one (e.g. requesting "Joy" can rank "Big Joy" top), and confidently
			// showing the wrong song's lyrics is worse than showing none.
			trace.log(`No confident Genius artist match for "${artist}" — "${title}"`);
		}
		return { lyrics: null, hits: allHits };
	}

	const html = await geniusFetchPage(best.url);
	const lyrics = extractLyricsFromPage(html);

	return { lyrics, hits: allHits, sourceUrl: best.url, sourceTitle: best.title };
};
