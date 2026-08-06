import { describe, it, expect } from "vitest";
import { buildYouTubeEmbedUrl, parseYouTubeUrl } from "./youtube-url";

describe("parseYouTubeUrl", () => {
  const accepted: [string, string, number | null][] = [
    ["https://www.youtube.com/watch?v=M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["https://youtube.com/watch?v=M7lc1UVf-VE&list=PL0", "M7lc1UVf-VE", null],
    ["https://m.youtube.com/watch?v=M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["https://youtu.be/M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["https://youtu.be/M7lc1UVf-VE?t=90", "M7lc1UVf-VE", 90],
    [
      "https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1h2m3s",
      "M7lc1UVf-VE",
      3723,
    ],
    ["https://www.youtube.com/shorts/M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["https://www.youtube.com/live/M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["https://www.youtube.com/embed/M7lc1UVf-VE?start=30", "M7lc1UVf-VE", 30],
    ["https://www.youtube-nocookie.com/embed/M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["youtube.com/watch?v=M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["M7lc1UVf-VE", "M7lc1UVf-VE", null],
    ["  https://youtu.be/M7lc1UVf-VE  ", "M7lc1UVf-VE", null],
  ];

  it.each(accepted)("parses %s", (input, videoId, start) => {
    expect(parseYouTubeUrl(input)).toEqual({ videoId, start });
  });

  const rejected: string[] = [
    "",
    "   ",
    "https://vimeo.com/12345",
    "https://www.youtube.com/",
    "https://www.youtube.com/watch",
    "https://www.youtube.com/watch?v=",
    "https://example.com/watch?v=M7lc1UVf-VE",
    "not a url at all with spaces",
    "https://www.youtube.com/watch?v=<script>",
  ];

  it.each(rejected)("rejects %s", (input) => {
    expect(parseYouTubeUrl(input)).toBeNull();
  });

  it("ignores an unparsable time designator", () => {
    expect(parseYouTubeUrl("https://youtu.be/M7lc1UVf-VE?t=abc")).toEqual({
      videoId: "M7lc1UVf-VE",
      start: null,
    });
  });
});

describe("buildYouTubeEmbedUrl", () => {
  it("always enables the JS API on the privacy-enhanced host", () => {
    const url = new URL(
      buildYouTubeEmbedUrl({
        videoId: "M7lc1UVf-VE",
        start: 0,
        muted: false,
        controls: true,
        origin: null,
      }),
    );
    expect(url.hostname).toBe("www.youtube-nocookie.com");
    expect(url.pathname).toBe("/embed/M7lc1UVf-VE");
    expect(url.searchParams.get("enablejsapi")).toBe("1");
    expect(url.searchParams.get("mute")).toBeNull();
    expect(url.searchParams.get("start")).toBeNull();
    expect(url.searchParams.get("controls")).toBeNull();
    expect(url.searchParams.get("origin")).toBeNull();
  });

  it("carries start, mute, controls, and origin options", () => {
    const url = new URL(
      buildYouTubeEmbedUrl({
        videoId: "M7lc1UVf-VE",
        start: 90.9,
        muted: true,
        controls: false,
        origin: "https://example.com",
      }),
    );
    expect(url.searchParams.get("start")).toBe("90");
    expect(url.searchParams.get("mute")).toBe("1");
    expect(url.searchParams.get("controls")).toBe("0");
    expect(url.searchParams.get("origin")).toBe("https://example.com");
  });
});
