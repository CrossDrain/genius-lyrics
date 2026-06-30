// Fetching and rendering Genius annotation notes — the "explanation" text
// behind a highlighted lyric fragment. Kept separate from genius.ts (which
// owns lyrics search/scrape/clean): this is a distinct concern with its own
// undocumented-schema risk surface, not lyrics extraction.

import DOMPurify from "dompurify";
import { Tracer } from "@luna/core";

import { geniusFetchAnnotation, geniusFetchReferent } from "./genius.native";

export const { trace } = Tracer("[Genius Lyrics]");

// --- Referent ID extraction ---------------------------------------------------
//
// Genius wraps an annotated lyric fragment in an <a> whose href's first path
// segment is the numeric referent ID (e.g. "/11593050/Artist-song/Some-fragment"),
// confirmed against a live genius.com page during the V2 pre-implementation
// spike. No `data-id` attribute was observed on current markup, but the
// fallback is kept defensively — cheap insurance against a future markup change,
// and it's exactly the kind of fallback lyrics-plus's ProviderGenius.js also kept.
//
// Typed as a narrow structural interface (not HTMLAnchorElement) so this is
// testable without a full DOM anchor element — any object with these two members
// satisfies it, including a real anchor.
interface AnchorLike {
	pathname: string;
	getAttribute(name: string): string | null;
}

export const extractAnnotationId = (anchor: AnchorLike): string | null => {
	const pathMatch = anchor.pathname.match(/^\/(\d+)\//);
	if (pathMatch) return pathMatch[1];
	const dataId = anchor.getAttribute("data-id");
	if (dataId) return dataId;
	return null;
};

/** Reject anything that isn't a clean integer string before it reaches a fetch URL. */
export const isValidAnnotationId = (id: string): boolean => /^\d+$/.test(id);

// --- DOM-JSON -> HTML ----------------------------------------------------------
//
// Genius's annotation body comes back as a JSON tree (`response.annotation.body.dom`),
// not HTML — confirmed shape via a live `/api/annotations/{id}` fetch during the
// spike: { tag, attributes?, children? } nodes, with plain strings as leaf children
// (including bare "" siblings between block elements — a serialization quirk, not
// an error). This walks that tree into an HTML string; DOMPurify (below) is the
// actual security boundary, not this allowlist — this is a data transform.

export interface GeniusDomElement {
	tag: string;
	attributes?: Record<string, unknown>;
	children?: GeniusDomNode[];
	/** Present on img nodes — Genius includes a pre-sized thumbnail we prefer
	 * over the full-resolution src for display in a narrow popover. */
	data?: { thumbnail?: { src?: string; width?: number; height?: number }; [key: string]: unknown };
}
export type GeniusDomNode = string | GeniusDomElement;

// "root" is a structural wrapper (no HTML element of its own). Anything not in
// ALLOWED_TAGS signals a genuine schema-drift surprise and throws, so the
// caller's unified fetch/parse error handling catches it.
const ALLOWED_TAGS = new Set([
	"root", "p", "a", "br", "blockquote", "b", "strong", "i", "em",
	// Headings — observed in the wild as a cross-reference link to another
	// annotation, not just a structural section title. Rendered via the
	// generic `<tag>...</tag>` fallback below, same as blockquote.
	"h1", "h2", "h3", "h4", "h5", "h6",
	// small/center — observed in the wild as an image caption sitting under a
	// photo. Rendered via the generic `<tag>...</tag>` fallback below, same as
	// blockquote/headings.
	"small", "center",
	// ul/li — bullet lists, confirmed via a broad sample of real annotations
	// across the ID space (no ol observed in that sample, so it's left out
	// until actually seen). Rendered via the generic tag-wrap fallback below,
	// same as blockquote/headings.
	"ul", "li",
	// hr — divider, also confirmed via that same sample. Self-closing, no
	// children, handled like br below.
	"hr",
	// img: rendered using the pre-sized thumbnail Genius provides so it fits
	// the narrow now-playing popover without requiring a full-res download.
	"img",
	// iframe/video/audio: too risky to embed directly inside a plugin popover;
	// rendered as a safe "View embed →" fallback link so content is still
	// reachable. audio nodes observed in the wild only carry a base64
	// `data.src` that isn't reliably an audio URL at all (one sample decoded to
	// an unrelated image URL) — handled below by simply falling back to the
	// same attributes.src-or-nothing logic as iframe/video rather than
	// trusting that opaque payload.
	"iframe", "video", "audio",
]);

const escapeHtml = (s: string): string =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");

const renderChildren = (children: GeniusDomNode[] | undefined): string =>
	(children ?? []).map(domJsonToHtml).join("");

export const domJsonToHtml = (node: GeniusDomNode): string => {
	if (typeof node === "string") return escapeHtml(node);

	if (!ALLOWED_TAGS.has(node.tag)) {
		throw new Error(`Unrecognized Genius annotation node type: "${node.tag}"`);
	}

	if (node.tag === "br") return "<br>";
	if (node.tag === "hr") return "<hr>";

	if (node.tag === "a") {
		const href = typeof node.attributes?.href === "string" ? node.attributes.href : "";
		return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${renderChildren(node.children)}</a>`;
	}

	if (node.tag === "img") {
		// Prefer the pre-sized thumbnail (typically 300px wide) over the full-res
		// src — it fits the narrow panel without a large download.
		const thumbSrc = typeof node.data?.thumbnail?.src === "string" ? node.data.thumbnail.src : null;
		const fullSrc = typeof node.attributes?.src === "string" ? node.attributes.src : null;
		const src = thumbSrc ?? fullSrc ?? "";
		const alt = typeof node.attributes?.alt === "string" ? node.attributes.alt : "";
		if (!src) return "";
		return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" class="gl-annotation-img">`;
	}

	if (node.tag === "iframe" || node.tag === "video" || node.tag === "audio") {
		// Never embed arbitrary iframes/videos/audio inside an Electron plugin
		// popover — render a safe clickable link instead so the content is still
		// reachable. Only attributes.src is trusted; audio nodes' data.src is
		// opaque/unreliable (see ALLOWED_TAGS comment above) so it's deliberately
		// not consulted here.
		const src = typeof node.attributes?.src === "string" ? node.attributes.src : "";
		if (!src) return "";
		return `<a href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer" class="gl-annotation-embed-link">▶ View embed</a>`;
	}

	if (node.tag === "root") return renderChildren(node.children);

	return `<${node.tag}>${renderChildren(node.children)}</${node.tag}>`;
};

// --- Sanitization ----------------------------------------------------------
//
// The actual XSS-prevention boundary. DOMPurify, not the allowlist walker above —
// a hand-rolled sanitizer is new, unaudited security-relevant code; DOMPurify is
// the proven standard for this (decided during /plan-eng-review, Issue 1A).

export const sanitizeAnnotationHtml = (html: string): string =>
	DOMPurify.sanitize(html, {
		ALLOWED_TAGS: [
			"p", "a", "br", "blockquote", "b", "strong", "i", "em", "img",
			"h1", "h2", "h3", "h4", "h5", "h6", "small", "center",
			"ul", "li", "hr",
		],
		ALLOWED_ATTR: ["href", "target", "rel", "src", "alt", "class"],
		// Restrict src/href to https:// only — no data:, javascript:, or http:.
		ALLOWED_URI_REGEXP: /^https:/,
	});

// --- Fetch orchestration ----------------------------------------------------
//
// Branches on `annotation.verified` (boolean) — corrected during the spike from
// the originally-planned `referent.classification === "verified"` check, which a
// live payload showed doesn't actually signal verification (a real annotation had
// classification: "accepted" and verified: false simultaneously).
//
// Throws on ANY failure (network, JSON parse, missing fields, unrecognized DOM
// node) — by design. The caller (index.ts's popover) catches all of it through one
// unified error path, per /plan-eng-review Issue 3A.

const parseDom = (dom: unknown): string => {
	if (!dom) throw new Error("Genius annotation response missing body.dom");
	return sanitizeAnnotationHtml(domJsonToHtml(dom as GeniusDomNode));
};

const parseJson = (raw: string, context: string): any => {
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error(`Genius ${context} response was not valid JSON`);
	}
};

export interface AnnotationNote {
	html: string;
	/** True when this is Genius's "verified"/artist-provided annotation, not a
	 * general community one — the caller renders a distinct badge for it. */
	verified: boolean;
}

export const fetchAnnotationNote = async (id: string): Promise<AnnotationNote> => {
	if (!isValidAnnotationId(id)) {
		throw new Error(`Invalid Genius annotation id: "${id}"`);
	}

	const annotationRaw = await geniusFetchAnnotation(id);
	const annotationJson = parseJson(annotationRaw, "annotation");
	const annotation = annotationJson?.response?.annotation;
	if (!annotation) throw new Error("Genius annotation response missing annotation body");

	// Use response.referent.classification === "verified" (from the FIRST call's
	// response), NOT annotation.verified (boolean) — live data confirmed
	// annotation.verified is always false even on genuinely-verified annotations;
	// the real signal lives in referent.classification. This matches lyrics-plus's
	// ProviderGenius.js, which was correct all along.
	if (annotationJson?.response?.referent?.classification === "verified") {
		const referentRaw = await geniusFetchReferent(id);
		const referentJson = parseJson(referentRaw, "referent");
		const dom = referentJson?.response?.referent?.annotations?.[0]?.body?.dom;
		return { html: parseDom(dom), verified: true };
	}

	return { html: parseDom(annotation.body?.dom), verified: false };
};
