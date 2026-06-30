import { describe, expect, it, vi } from "vitest";

import {
	domJsonToHtml,
	extractAnnotationId,
	fetchAnnotationNote,
	isValidAnnotationId,
	sanitizeAnnotationHtml,
} from "./genius.annotations";

vi.mock("./genius.native", () => ({
	geniusFetchAnnotation: vi.fn(),
	geniusFetchReferent: vi.fn(),
}));

import { geniusFetchAnnotation, geniusFetchReferent } from "./genius.native";

describe("extractAnnotationId", () => {
	it("extracts the id from a URL path like /11593050/Artist-song/fragment", () => {
		const anchor = { pathname: "/11593050/Some-artist-song-title/Intro", getAttribute: () => null };
		expect(extractAnnotationId(anchor)).toBe("11593050");
	});

	it("falls back to data-id when the path has no numeric segment", () => {
		const anchor = { pathname: "/some-page", getAttribute: (name: string) => (name === "data-id" ? "42" : null) };
		expect(extractAnnotationId(anchor)).toBe("42");
	});

	it("returns null when neither is present", () => {
		const anchor = { pathname: "/some-page", getAttribute: () => null };
		expect(extractAnnotationId(anchor)).toBeNull();
	});
});

describe("isValidAnnotationId", () => {
	it("accepts a clean integer string", () => {
		expect(isValidAnnotationId("11593050")).toBe(true);
	});

	it("rejects non-numeric input", () => {
		expect(isValidAnnotationId("abc123")).toBe(false);
		expect(isValidAnnotationId("")).toBe(false);
		expect(isValidAnnotationId("12.5")).toBe(false);
	});
});

describe("domJsonToHtml", () => {
	it("renders bold/italic/line-break/link nodes", () => {
		const html = domJsonToHtml({
			tag: "root",
			children: [
				{ tag: "p", children: ["First line of a note", { tag: "br" }, "second line of the note"] },
				{ tag: "a", attributes: { href: "https://example.com" }, children: ["a link"] },
				{ tag: "b", children: ["bold text"] },
				{ tag: "i", children: ["italic text"] },
			],
		});
		expect(html).toContain("First line of a note<br>second line of the note");
		expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">a link</a>');
		expect(html).toContain("<b>bold text</b>");
		expect(html).toContain("<i>italic text</i>");
	});

	it("renders blockquote", () => {
		const html = domJsonToHtml({ tag: "blockquote", children: [{ tag: "p", children: ["quoted"] }] });
		expect(html).toBe("<blockquote><p>quoted</p></blockquote>");
	});

	it("renders a heading, e.g. a cross-reference link to another annotation", () => {
		const html = domJsonToHtml({
			tag: "h2",
			children: [{ tag: "a", attributes: { href: "https://genius.com/4636486" }, children: ["see other annotation"] }],
		});
		expect(html).toBe(
			'<h2><a href="https://genius.com/4636486" target="_blank" rel="noopener noreferrer">see other annotation</a></h2>',
		);
	});

	it("renders small/center, e.g. an image caption", () => {
		const html = domJsonToHtml({
			tag: "small",
			children: [{ tag: "center", children: ["a caption"] }],
		});
		expect(html).toBe("<small><center>a caption</center></small>");
	});

	it("renders a bullet list", () => {
		const html = domJsonToHtml({
			tag: "ul",
			children: [{ tag: "li", children: ["one"] }, { tag: "li", children: ["two"] }],
		});
		expect(html).toBe("<ul><li>one</li><li>two</li></ul>");
	});

	it("renders hr as a self-closing divider", () => {
		expect(domJsonToHtml({ tag: "hr" })).toBe("<hr>");
	});

	it("tolerates bare string and empty-string children between block elements", () => {
		const html = domJsonToHtml({
			tag: "root",
			children: [{ tag: "p", children: ["first"] }, "", { tag: "p", children: ["second"] }],
		});
		expect(html).toBe("<p>first</p><p>second</p>");
	});

	it("renders img using the thumbnail src when available", () => {
		const html = domJsonToHtml({
			tag: "img",
			attributes: { src: "https://images.genius.com/full.jpg", alt: "screenshot" },
			data: { thumbnail: { src: "https://images.genius.com/thumb.jpg", width: 300 } },
		});
		expect(html).toContain('src="https://images.genius.com/thumb.jpg"');
		expect(html).toContain('alt="screenshot"');
		expect(html).toContain("gl-annotation-img");
	});

	it("falls back to full src when no thumbnail is present", () => {
		const html = domJsonToHtml({
			tag: "img",
			attributes: { src: "https://images.genius.com/full.jpg", alt: "" },
		});
		expect(html).toContain('src="https://images.genius.com/full.jpg"');
	});

	it("returns empty string for img nodes with no src", () => {
		expect(domJsonToHtml({ tag: "img" })).toBe("");
	});

	it("renders iframe as a safe fallback link, not an actual embed", () => {
		const html = domJsonToHtml({
			tag: "iframe",
			attributes: { src: "https://www.youtube.com/embed/abc123" },
		});
		expect(html).toContain('href="https://www.youtube.com/embed/abc123"');
		expect(html).toContain("gl-annotation-embed-link");
		expect(html).not.toContain("<iframe");
	});

	it("ignores an audio node whose only src lives in the opaque base64 data field", () => {
		const html = domJsonToHtml({
			tag: "audio",
			attributes: { type: "audio/mpeg", preload: "none" },
			data: { decode: "true", src: "aHR0cHM6Ly9leGFtcGxlLmNvbS9wbGFjZWhvbGRlci1pbWFnZS5qcGc=" },
			children: [""],
		});
		expect(html).toBe("");
	});

	it("renders audio as a safe fallback link when attributes.src is present", () => {
		const html = domJsonToHtml({
			tag: "audio",
			attributes: { src: "https://images.genius.com/some-clip.mp3" },
		});
		expect(html).toContain('href="https://images.genius.com/some-clip.mp3"');
		expect(html).toContain("gl-annotation-embed-link");
		expect(html).not.toContain("<audio");
	});

	it("throws on an unrecognized node type", () => {
		expect(() => domJsonToHtml({ tag: "table", children: [] })).toThrow(/Unrecognized Genius annotation node type/);
	});
});

describe("sanitizeAnnotationHtml", () => {
	it("strips script tags", () => {
		const out = sanitizeAnnotationHtml("<p>hello<script>alert(1)</script></p>");
		expect(out).not.toContain("<script>");
		expect(out).not.toContain("alert(1)");
	});

	it("strips inline event handler attributes", () => {
		const out = sanitizeAnnotationHtml('<a href="https://example.com" onclick="alert(1)">link</a>');
		expect(out).not.toContain("onclick");
	});

	it("strips javascript: URLs", () => {
		const out = sanitizeAnnotationHtml('<a href="javascript:alert(1)">link</a>');
		expect(out).not.toContain("javascript:");
	});

	it("keeps allowlisted formatting intact", () => {
		const out = sanitizeAnnotationHtml("<p><b>bold</b> and <i>italic</i></p>");
		expect(out).toBe("<p><b>bold</b> and <i>italic</i></p>");
	});

	it("keeps heading tags intact", () => {
		const out = sanitizeAnnotationHtml("<h2>a heading</h2>");
		expect(out).toBe("<h2>a heading</h2>");
	});

	it("keeps small/center tags intact", () => {
		const out = sanitizeAnnotationHtml("<small><center>a caption</center></small>");
		expect(out).toBe("<small><center>a caption</center></small>");
	});

	it("keeps list and hr tags intact", () => {
		const out = sanitizeAnnotationHtml("<ul><li>one</li></ul><hr>");
		expect(out).toBe("<ul><li>one</li></ul><hr>");
	});
});

describe("fetchAnnotationNote", () => {
	it("rejects an invalid id before ever calling fetch", async () => {
		await expect(fetchAnnotationNote("not-a-number")).rejects.toThrow(/Invalid Genius annotation id/);
		expect(geniusFetchAnnotation).not.toHaveBeenCalled();
	});

	it("uses annotation.body.dom directly when classification is not 'verified'", async () => {
		vi.mocked(geniusFetchAnnotation).mockResolvedValueOnce(
			JSON.stringify({
				response: {
					annotation: { verified: false, body: { dom: { tag: "p", children: ["a note"] } } },
					referent: { classification: "accepted" },
				},
			}),
		);

		const note = await fetchAnnotationNote("123");
		expect(note).toEqual({ html: "<p>a note</p>", verified: false });
		expect(geniusFetchReferent).not.toHaveBeenCalled();
	});

	it("fetches the referent when classification is 'verified'", async () => {
		vi.mocked(geniusFetchAnnotation).mockResolvedValueOnce(
			JSON.stringify({ response: { annotation: { verified: false }, referent: { classification: "verified" } } }),
		);
		vi.mocked(geniusFetchReferent).mockResolvedValueOnce(
			JSON.stringify({
				response: { referent: { annotations: [{ body: { dom: { tag: "p", children: ["verified note"] } } }] } },
			}),
		);

		const note = await fetchAnnotationNote("123");
		expect(note).toEqual({ html: "<p>verified note</p>", verified: true });
		expect(geniusFetchReferent).toHaveBeenCalledWith("123");
	});

	it("throws when the annotation fetch fails", async () => {
		vi.mocked(geniusFetchAnnotation).mockRejectedValueOnce(new Error("network down"));
		await expect(fetchAnnotationNote("123")).rejects.toThrow("network down");
	});

	it("throws when the response is not valid JSON", async () => {
		vi.mocked(geniusFetchAnnotation).mockResolvedValueOnce("not json");
		await expect(fetchAnnotationNote("123")).rejects.toThrow(/not valid JSON/);
	});

	it("throws when the DOM tree contains an unrecognized node (caught by caller's unified error path)", async () => {
		vi.mocked(geniusFetchAnnotation).mockResolvedValueOnce(
			JSON.stringify({
				response: { annotation: { verified: false, body: { dom: { tag: "totally-unknown-tag" } } } },
			}),
		);
		await expect(fetchAnnotationNote("123")).rejects.toThrow(/Unrecognized Genius annotation node type/);
	});
});
