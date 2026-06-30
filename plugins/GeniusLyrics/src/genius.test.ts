import { describe, expect, it, vi } from "vitest";

vi.mock("./genius.native", () => ({
	geniusSearch: vi.fn(),
	geniusFetchPage: vi.fn(),
}));

// extractLyricsFromPage is not exported (kept internal, same as the original
// V1 code) — test it through the same DOMParser-based page shape it consumes,
// by re-implementing the minimal page wrapper inline. Exporting it for tests
// alone isn't worth widening the public API of a module that already exports
// the types tests need to assert against.
import { fetchGeniusLyrics, type LyricLine } from "./genius";
import { geniusFetchPage, geniusSearch } from "./genius.native";

const wrapPage = (lyricsHtml: string): string =>
	`<html><body><div data-lyrics-container="true">${lyricsHtml}</div></body></html>`;

const searchResponse = (
	hits: Array<{ title: string; url: string; artist: string; featured?: string[]; instrumental?: boolean }>,
) =>
	JSON.stringify({
		response: {
			sections: [
				{
					hits: hits.map((h) => ({
						result: {
							full_title: h.title,
							url: h.url,
							primary_artist_names: h.artist,
							featured_artists: (h.featured ?? []).map((name) => ({ name })),
							instrumental: h.instrumental ?? false,
						},
					})),
				},
			],
		},
	});

const setupFetch = async (lyricsHtml: string) => {
	vi.mocked(geniusSearch).mockResolvedValue(
		searchResponse([{ title: "Song", url: "https://genius.com/song", artist: "Artist" }]),
	);
	vi.mocked(geniusFetchPage).mockResolvedValue(wrapPage(lyricsHtml));
	return fetchGeniusLyrics("Song", "Artist");
};

describe("extractLyricsFromPage (via fetchGeniusLyrics)", () => {
	it("classifies a section header line", async () => {
		const result = await setupFetch("[Verse 1]<br>Hello world");
		expect(result.lyrics).toEqual<LyricLine[]>([
			{ kind: "header", text: "Verse 1" },
			{ kind: "text", segments: [{ text: "Hello world" }] },
		]);
	});

	it("classifies a blank stanza-break line", async () => {
		const result = await setupFetch("First line<br><br>Second line");
		expect(result.lyrics).toEqual<LyricLine[]>([
			{ kind: "text", segments: [{ text: "First line" }] },
			{ kind: "blank" },
			{ kind: "text", segments: [{ text: "Second line" }] },
		]);
	});

	it("classifies a plain text line with no annotations", async () => {
		const result = await setupFetch("Just a normal lyric line");
		expect(result.lyrics).toEqual<LyricLine[]>([
			{ kind: "text", segments: [{ text: "Just a normal lyric line" }] },
		]);
	});

	it("extracts a single annotated fragment within a line", async () => {
		const result = await setupFetch(
			'Before <a href="/123456/Artist-song/annotated-bit">annotated bit</a> after',
		);
		expect(result.lyrics).toEqual<LyricLine[]>([
			{
				kind: "text",
				segments: [
					{ text: "Before " },
					{ text: "annotated bit", annotationId: "123456" },
					{ text: " after" },
				],
			},
		]);
	});

	it("keeps multiple independent annotated fragments in the same line distinct", async () => {
		const result = await setupFetch(
			'<a href="/111/a/x">first</a> middle <a href="/222/a/y">second</a>',
		);
		expect(result.lyrics).toEqual<LyricLine[]>([
			{
				kind: "text",
				segments: [
					{ text: "first", annotationId: "111" },
					{ text: " middle " },
					{ text: "second", annotationId: "222" },
				],
			},
		]);
	});

	it("carries one annotation id across multiple lines when <br> is nested inside the anchor", async () => {
		const result = await setupFetch(
			'<a href="/999/a/x">[Intro]<br>First annotated line<br>Second annotated line</a>',
		);
		expect(result.lyrics).toEqual<LyricLine[]>([
			{ kind: "header", text: "Intro" },
			{ kind: "text", segments: [{ text: "First annotated line", annotationId: "999" }] },
			{ kind: "text", segments: [{ text: "Second annotated line", annotationId: "999" }] },
		]);
	});

	it("strips data-exclude-from-selection content (contributor/translation header chrome)", async () => {
		const result = await setupFetch(
			'<div data-exclude-from-selection="true">1061 Contributors<a href="https://genius.com/x">Türkçe</a></div>Actual lyric line',
		);
		expect(result.lyrics).toEqual<LyricLine[]>([{ kind: "text", segments: [{ text: "Actual lyric line" }] }]);
	});

	it("ignores a data-id that isn't a clean integer (rejected at the extraction boundary)", async () => {
		const result = await setupFetch('<a href="/not-a-path" data-id="abc">not clickable</a>');
		expect(result.lyrics).toEqual<LyricLine[]>([{ kind: "text", segments: [{ text: "not clickable" }] }]);
	});

	it("returns null when no lyrics containers exist on the page", async () => {
		vi.mocked(geniusSearch).mockResolvedValue(
			searchResponse([{ title: "Song", url: "https://genius.com/song", artist: "Artist" }]),
		);
		vi.mocked(geniusFetchPage).mockResolvedValue("<html><body>no lyrics here</body></html>");
		const result = await fetchGeniusLyrics("Song", "Artist");
		expect(result.lyrics).toBeNull();
	});
});

describe("artist matching", () => {
	it("picks the hit whose featured artist matches, not just whichever shares the primary artist", async () => {
		// Two hits share the same primary artist and near-identical title (e.g. a
		// recurring numbered series) — only the featured-artist credit tells them
		// apart, and the correct one is NOT first in search-result order.
		vi.mocked(geniusSearch).mockResolvedValue(
			searchResponse([
				{ title: "Series Vol. 11", url: "https://genius.com/series-vol-11", artist: "Main Artist" },
				{
					title: "Series Vol. 12",
					url: "https://genius.com/series-vol-12",
					artist: "Main Artist",
					featured: ["Guest Artist"],
				},
			]),
		);
		vi.mocked(geniusFetchPage).mockResolvedValue(wrapPage("the right one"));

		const result = await fetchGeniusLyrics("Series Vol. 12", "Main Artist, Guest Artist");
		expect(result.sourceUrl).toBe("https://genius.com/series-vol-12");
	});

	it("does not fall back to an unrelated top hit when no candidate clears the confidence bar", async () => {
		// "Solo" coincidentally appears as a substring of the unrelated "Big Solo"
		// — a single shared token shouldn't be trusted as a match.
		vi.mocked(geniusSearch).mockResolvedValue(
			searchResponse([
				{ title: "Unrelated Song", url: "https://genius.com/unrelated", artist: "Big Solo" },
			]),
		);
		vi.mocked(geniusFetchPage).mockClear();
		vi.mocked(geniusFetchPage).mockResolvedValue(wrapPage("should never be fetched"));

		const result = await fetchGeniusLyrics("Some Song", "Solo");
		expect(result.lyrics).toBeNull();
		expect(result.sourceUrl).toBeUndefined();
		expect(geniusFetchPage).not.toHaveBeenCalled();
	});
});
