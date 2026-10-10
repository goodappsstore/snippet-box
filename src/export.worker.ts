import { generateSnippetsPdf } from "./pdf-export";
import { generateSnippetsHtml } from "./html-export";
import { Snippet, Collection } from "./types";

export interface ExportWorkerRequest {
  formats: ("pdf" | "html" | "json")[];
  snippets: Snippet[];
  collections: Collection[];
  baseFilename: string;
}

export type ExportWorkerResponse =
  | {
      type: "progress";
      percent: number;
      stage: string;
      current: number;
      total: number;
    }
  | {
      type: "success";
      results: {
        format: "pdf" | "html" | "json";
        data: ArrayBuffer | string;
      }[];
    }
  | {
      type: "error";
      error: string;
    };

self.onmessage = async (e: MessageEvent<ExportWorkerRequest>) => {
  const { formats, snippets, collections, baseFilename } = e.data;
  try {
    const results: { format: "pdf" | "html" | "json"; data: ArrayBuffer | string }[] = [];
    const totalFormats = formats.length;

    for (let fIdx = 0; fIdx < formats.length; fIdx++) {
      const fmt = formats[fIdx];
      const basePercent = (fIdx / totalFormats) * 100;
      const formatWeight = 100 / totalFormats;

      if (fmt === "json") {
        self.postMessage({
          type: "progress",
          percent: Math.round(basePercent + formatWeight * 0.5),
          stage: "Generating JSON structured data…",
          current: snippets.length,
          total: snippets.length,
        });

        const jsonText = JSON.stringify(snippets, null, 2);
        results.push({ format: "json", data: jsonText });

        self.postMessage({
          type: "progress",
          percent: Math.round(basePercent + formatWeight),
          stage: "JSON data ready",
          current: snippets.length,
          total: snippets.length,
        });
      } else if (fmt === "pdf") {
        self.postMessage({
          type: "progress",
          percent: Math.round(basePercent),
          stage: "Preparing PDF document…",
          current: 0,
          total: snippets.length,
        });

        const buffer = await generateSnippetsPdf(
          snippets,
          collections,
          baseFilename,
          (current, total, title) => {
            const fraction = total > 0 ? current / total : 1;
            self.postMessage({
              type: "progress",
              percent: Math.round(basePercent + formatWeight * fraction * 0.95),
              stage: `Rendering PDF page for snippet ${current} of ${total} (${title.slice(0, 30)})`,
              current,
              total,
            });
          }
        );

        results.push({ format: "pdf", data: buffer });
      } else if (fmt === "html") {
        self.postMessage({
          type: "progress",
          percent: Math.round(basePercent),
          stage: "Building interactive HTML document…",
          current: 0,
          total: snippets.length,
        });

        const htmlText = generateSnippetsHtml(
          snippets,
          collections,
          baseFilename,
          (current, total, title) => {
            const fraction = total > 0 ? current / total : 1;
            self.postMessage({
              type: "progress",
              percent: Math.round(basePercent + formatWeight * fraction * 0.95),
              stage: `Syntax highlighting HTML snippet ${current} of ${total} (${title.slice(0, 30)})`,
              current,
              total,
            });
          }
        );

        results.push({ format: "html", data: htmlText });
      }
    }

    self.postMessage({
      type: "progress",
      percent: 100,
      stage: "Generation complete. Finalizing output…",
      current: snippets.length,
      total: snippets.length,
    });

    self.postMessage({ type: "success", results });
  } catch (err: any) {
    self.postMessage({ type: "error", error: String(err?.message || err) });
  }
};
