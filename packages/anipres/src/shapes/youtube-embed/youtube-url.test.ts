import { describe, it, expect } from "vitest";
import { parseYouTubeUrl } from "./youtube-url";

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
