declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    YT: any;
    __youtubeApiReadyPromise__?: Promise<typeof window.YT>;
  }
}

async function loadYouTubeScript(): Promise<typeof window.YT> {
  if (
    !document.querySelector("script[src^='https://www.youtube.com/iframe_api']")
  ) {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);

    window.__youtubeApiReadyPromise__ = new Promise<typeof window.YT>(
      (resolve) => {
        window.onYouTubeIframeAPIReady = () => {
          resolve(window.YT);
        };
      },
    );
  }

  return window.__youtubeApiReadyPromise__;
}

export class YouTubeIframeRegistry {
  private readyPlayerPromises: Map<string, Promise<typeof window.YT.Player>> =
    new Map();

  public add(id: string, iframe: HTMLIFrameElement) {
    console.debug("YouTubeIframeRegistry.add", id, iframe);

    const playerPromise = loadYouTubeScript().then((YT) => {
      return new Promise<typeof window.YT.Player>((resolve) => {
        const player = new YT.Player(iframe, {
          events: {
            onReady: () => {
              console.log("onReady");
              resolve(player);
            },
          },
        });
      });
    });

    this.readyPlayerPromises.set(id, playerPromise);
  }

  public async play(id: string) {
    console.debug("YouTubeIframeRegistry.play", id);

    const playerPromise = this.readyPlayerPromises.get(id);
    if (playerPromise == null) {
      return;
    }

    const player = await playerPromise;
    player.playVideo();
  }
}
