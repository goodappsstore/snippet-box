import { Snippet, Collection } from "./types";
import { generateSnippetsPdf } from "./pdf-export";
import { generateSnippetsHtml } from "./html-export";
import type { ExportWorkerRequest, ExportWorkerResponse } from "./export.worker";

export interface ExportProgressEvent {
  percent: number;
  stage: string;
  current: number;
  total: number;
}

export interface GeneratedExportResult {
  format: "pdf" | "html" | "json";
  data: ArrayBuffer | string;
}

/**
 * Offloads heavy document generation (PDF / HTML / JSON) to a background Web Worker thread,
 * keeping the main UI thread completely responsive and unblocked.
 * Falls back gracefully to async micro-task yielding if Web Workers are restricted.
 */
export async function runExportInBackground(
  formats: ("pdf" | "html" | "json")[],
  snippets: Snippet[],
  collections: Collection[],
  baseFilename: string,
  onProgress: (evt: ExportProgressEvent) => void
): Promise<GeneratedExportResult[]> {
  // Check if Web Workers are supported
  if (typeof window !== "undefined" && typeof window.Worker === "function") {
    try {
      return await new Promise<GeneratedExportResult[]>((resolve, reject) => {
        const worker = new Worker(new URL("./export.worker.ts", import.meta.url), {
          type: "module",
        });

        worker.onmessage = (e: MessageEvent<ExportWorkerResponse>) => {
          const msg = e.data;
          if (msg.type === "progress") {
            onProgress({
              percent: msg.percent,
              stage: msg.stage,
              current: msg.current,
              total: msg.total,
            });
          } else if (msg.type === "success") {
            worker.terminate();
            resolve(msg.results);
          } else if (msg.type === "error") {
            worker.terminate();
            reject(new Error(msg.error));
          }
        };

        worker.onerror = (err) => {
          worker.terminate();
          console.error("Export worker encountered an error:", err);
          reject(new Error(err.message || "Background worker export failed"));
        };

        const payload: ExportWorkerRequest = {
          formats,
          snippets,
          collections,
          baseFilename,
        };

        worker.postMessage(payload);
      });
    } catch (workerErr) {
      console.warn("Could not launch background worker, falling back to main thread async execution:", workerErr);
    }
  }

  // Graceful fallback with async frame yielding
  const results: GeneratedExportResult[] = [];
  const totalFormats = formats.length;

  for (let fIdx = 0; fIdx < formats.length; fIdx++) {
    const fmt = formats[fIdx];
    const basePercent = (fIdx / totalFormats) * 100;
    const formatWeight = 100 / totalFormats;

    // Yield to let browser update UI
    await new Promise((r) => setTimeout(r, 16));

    if (fmt === "json") {
      onProgress({
        percent: Math.round(basePercent + formatWeight * 0.5),
        stage: "Generating JSON structured data…",
        current: snippets.length,
        total: snippets.length,
      });

      const jsonText = JSON.stringify(snippets, null, 2);
      results.push({ format: "json", data: jsonText });
    } else if (fmt === "pdf") {
      onProgress({
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
          onProgress({
            percent: Math.round(basePercent + formatWeight * fraction * 0.95),
            stage: `Rendering PDF page for snippet ${current} of ${total} (${title.slice(0, 30)})`,
            current,
            total,
          });
        }
      );
      results.push({ format: "pdf", data: buffer });
    } else if (fmt === "html") {
      onProgress({
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
          onProgress({
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

  onProgress({
    percent: 100,
    stage: "Generation complete. Finalizing output…",
    current: snippets.length,
    total: snippets.length,
  });

  return results;
}
