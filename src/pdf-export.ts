import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { Snippet, Collection } from "./types";

/* =========================================================
   Color Tokens (Nordic Obsidian Theme)
   ========================================================= */
export const C_OBSIDIAN: [number, number, number] = [15, 23, 42];     // #0f172a Deep Obsidian Slate
export const C_NAVY: [number, number, number] = [20, 28, 46];         // #141c2e Surface
export const C_MINT: [number, number, number] = [16, 185, 129];       // #10b981 Mint accent
export const C_INDIGO: [number, number, number] = [99, 102, 241];     // #6366f1 Indigo accent
export const C_CYAN: [number, number, number] = [6, 182, 212];        // #06b6d4 Cyan accent
export const C_AMBER: [number, number, number] = [245, 158, 11];      // #f59e0b Amber / Favorite
export const C_DARK: [number, number, number] = [15, 23, 42];         // #0f172a Dark text
export const C_MUTED: [number, number, number] = [100, 116, 139];     // #64748b Secondary text
export const C_FAINT: [number, number, number] = [148, 163, 184];     // #94a3b8 Faint line text
export const C_CARD_BG: [number, number, number] = [248, 250, 252];   // #f8fafc
export const C_CARD_BORDER: [number, number, number] = [226, 232, 240]; // #e2e8f0
export const C_CODE_BG: [number, number, number] = [248, 250, 252];   // #f8fafc Code block background
export const C_CODE_HEADER: [number, number, number] = [241, 245, 249]; // #f1f5f9
export const C_PILL_BG: [number, number, number] = [238, 242, 250];   // #eef2fa

/**
 * Sanitize strings for Latin-1 jsPDF rendering to prevent unexpected artifacts
 */
function sanitizeForPdf(input: string): string {
  if (!input) return "";
  return input
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export class SnippetPdfBuilder {
  doc: jsPDF;
  pageWidth: number;
  pageHeight: number;
  margin: number;
  contentWidth: number;
  cursorY: number;
  title: string;
  subtitle: string;
  dateStr: string;

  constructor(title: string, subtitle = "SnippetBox Personal Snippet Archive") {
    this.doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    this.pageWidth = this.doc.internal.pageSize.getWidth();
    this.pageHeight = this.doc.internal.pageSize.getHeight();
    this.margin = 36; // 0.5 inch margins
    this.contentWidth = this.pageWidth - this.margin * 2;
    this.cursorY = this.margin;
    this.title = sanitizeForPdf(title);
    this.subtitle = sanitizeForPdf(subtitle);
    this.dateStr = new Date().toISOString().slice(0, 10);
  }

  ensureSpace(neededPt: number) {
    if (this.cursorY + neededPt > this.pageHeight - this.margin - 30) {
      this.doc.addPage();
      this.cursorY = this.margin;
    }
  }

  drawHeader(metadataPills: { label: string; value: string }[], snippetCount: number) {
    const doc = this.doc;
    const contentW = this.contentWidth;

    // Top primary banner
    doc.setFillColor(...C_OBSIDIAN);
    doc.rect(this.margin, this.cursorY, contentW, 54, "F");

    // Accent line at banner bottom
    doc.setFillColor(...C_MINT);
    doc.rect(this.margin, this.cursorY + 52, contentW, 2, "F");

    // Brand label
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8.5);
    doc.setTextColor(148, 163, 184);
    doc.text("SNIPPETBOX  ·  SNIPPET ARCHIVE", this.margin + 16, this.cursorY + 18);

    // Document Title
    doc.setFontSize(14);
    doc.setTextColor(255, 255, 255);
    const safeTitle = this.title.length > 38 ? this.title.slice(0, 35) + "…" : this.title;
    doc.text(safeTitle, this.margin + 16, this.cursorY + 38);

    // Right-side info
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(203, 213, 225);
    const rightText = `Export Date: ${this.dateStr}  |  ${snippetCount} ${snippetCount === 1 ? "Snippet" : "Snippets"}`;
    doc.text(rightText, this.pageWidth - this.margin - 16, this.cursorY + 30, { align: "right" });

    this.cursorY += 62;

    // Subtitle
    if (this.subtitle) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.5);
      doc.setTextColor(...C_MUTED);
      doc.text(this.subtitle, this.margin, this.cursorY + 6);
      this.cursorY += 16;
    }

    // Metadata pills bar
    if (metadataPills.length > 0) {
      doc.setFillColor(...C_CARD_BG);
      doc.setDrawColor(...C_CARD_BORDER);
      doc.setLineWidth(0.8);
      doc.roundedRect(this.margin, this.cursorY, contentW, 24, 3, 3, "FD");

      let pillX = this.margin + 10;
      doc.setFontSize(8);
      for (const pill of metadataPills) {
        doc.setFont("helvetica", "bold");
        doc.setTextColor(...C_DARK);
        doc.text(`${pill.label}: `, pillX, this.cursorY + 15);
        const labelW = doc.getTextWidth(`${pill.label}: `);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...C_INDIGO);
        doc.text(pill.value, pillX + labelW, this.cursorY + 15);
        pillX += labelW + doc.getTextWidth(pill.value) + 18;
      }
      this.cursorY += 30;
    }
  }

  drawKpis(cards: { label: string; value: string; sub?: string; color?: "mint" | "indigo" | "amber" | "neutral" }[]) {
    this.ensureSpace(55);
    const doc = this.doc;
    const contentW = this.contentWidth;
    const count = cards.length;
    const gap = 10;
    const cardW = (contentW - gap * (count - 1)) / count;
    const cardH = 46;

    for (let i = 0; i < count; i++) {
      const c = cards[i];
      const x = this.margin + i * (cardW + gap);
      const y = this.cursorY;

      // Card container
      doc.setFillColor(...C_CARD_BG);
      doc.setDrawColor(...C_CARD_BORDER);
      doc.setLineWidth(0.8);
      doc.roundedRect(x, y, cardW, cardH, 4, 4, "FD");

      // Card label
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.setTextColor(...C_MUTED);
      doc.text(c.label.toUpperCase(), x + 8, y + 13);

      // Card value
      doc.setFontSize(11);
      if (c.color === "mint") doc.setTextColor(...C_MINT);
      else if (c.color === "indigo") doc.setTextColor(...C_INDIGO);
      else if (c.color === "amber") doc.setTextColor(...C_AMBER);
      else doc.setTextColor(...C_DARK);
      doc.text(c.value, x + 8, y + 28);

      // Subtitle if provided
      if (c.sub) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor(...C_MUTED);
        doc.text(c.sub, x + 8, y + 39);
      }
    }
    this.cursorY += cardH + 12;
  }

  drawSummaryTable(snippets: Snippet[], collectionsMap: Map<string, Collection>) {
    this.ensureSpace(60);
    const doc = this.doc;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...C_OBSIDIAN);
    doc.text("Exported Snippets Index", this.margin, this.cursorY + 10);
    this.cursorY += 16;

    const tableRows = snippets.map((s, idx) => {
      const colName = collectionsMap.get(s.collectionId)?.name || "Default";
      const tagsStr = s.tags.length > 0 ? s.tags.map((t) => `#${t}`).join(", ") : "—";
      const lineCount = s.content ? s.content.split("\n").length : 0;
      return [
        String(idx + 1),
        sanitizeForPdf(s.title || "Untitled"),
        (s.language || "text").toUpperCase(),
        sanitizeForPdf(colName),
        sanitizeForPdf(tagsStr),
        `${lineCount} lines`,
      ];
    });

    autoTable(this.doc, {
      startY: this.cursorY,
      margin: { left: this.margin, right: this.margin },
      theme: "striped",
      styles: {
        fontSize: 7.5,
        cellPadding: 4,
        textColor: C_DARK,
        lineColor: C_CARD_BORDER,
        lineWidth: 0.5,
      },
      headStyles: {
        fillColor: C_OBSIDIAN,
        textColor: [255, 255, 255],
        fontStyle: "bold",
        fontSize: 7.5,
      },
      alternateRowStyles: {
        fillColor: [248, 250, 252],
      },
      head: [["#", "Snippet Title", "Language", "Collection", "Tags", "Length"]],
      body: tableRows,
      columnStyles: {
        0: { cellWidth: 22, halign: "center" },
        1: { cellWidth: 140, fontStyle: "bold" },
        2: { cellWidth: 62 },
        3: { cellWidth: 70 },
        4: { cellWidth: "auto" },
        5: { cellWidth: 50, halign: "right" },
      },
    });

    this.cursorY = (this.doc as any).lastAutoTable?.finalY
      ? (this.doc as any).lastAutoTable.finalY + 16
      : this.cursorY + 24;
  }

  drawSnippet(
    snippet: Snippet,
    collection?: Collection,
    index?: number,
    totalCount?: number
  ) {
    // Check space for snippet title, metadata header, and first chunk of code
    this.ensureSpace(90);
    const doc = this.doc;
    const contentW = this.contentWidth;

    // Header divider bar with title
    doc.setFillColor(...C_CARD_BG);
    doc.setDrawColor(...C_CARD_BORDER);
    doc.setLineWidth(0.8);
    doc.roundedRect(this.margin, this.cursorY, contentW, 26, 3, 3, "FD");

    // Title text
    const indexPrefix =
      index !== undefined && totalCount !== undefined && totalCount > 1
        ? `${index}. `
        : index !== undefined
        ? `${index}. `
        : "";
    const titleText = sanitizeForPdf(`${indexPrefix}${snippet.title || "Untitled"}`);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.5);
    doc.setTextColor(...C_OBSIDIAN);
    doc.text(titleText, this.margin + 8, this.cursorY + 16);

    // Badges on right of header: Language & Favorite
    let rightOffset = this.pageWidth - this.margin - 8;
    if (snippet.favorite) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.5);
      doc.setTextColor(...C_AMBER);
      const favText = "★ FAVORITE";
      const favW = doc.getTextWidth(favText);
      doc.text(favText, rightOffset, this.cursorY + 16, { align: "right" });
      rightOffset -= favW + 12;
    }

    const langBadge = (snippet.language || "text").toUpperCase();
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(...C_INDIGO);
    doc.text(langBadge, rightOffset, this.cursorY + 16, { align: "right" });

    this.cursorY += 30;

    // Metadata Row: Collection, Created, Updated, Copy Count
    const metaParts: string[] = [];
    if (collection) {
      metaParts.push(`Collection: ${sanitizeForPdf(collection.name)}`);
    }
    if (snippet.createdAt) {
      metaParts.push(`Created: ${snippet.createdAt.slice(0, 10)}`);
    }
    if (snippet.updatedAt) {
      metaParts.push(`Updated: ${snippet.updatedAt.slice(0, 10)}`);
    }
    if (snippet.copyCount > 0) {
      metaParts.push(`Copied: ${snippet.copyCount}x`);
    }

    if (metaParts.length > 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(...C_MUTED);
      doc.text(metaParts.join("   ·   "), this.margin + 2, this.cursorY + 4);
      this.cursorY += 12;
    }

    // Tags & Keywords Row
    const tagItems: string[] = [];
    if (snippet.tags.length > 0) {
      tagItems.push(`Tags: ${snippet.tags.map((t) => `#${sanitizeForPdf(t)}`).join(" ")}`);
    }
    if (snippet.keywords.length > 0) {
      tagItems.push(`Keywords: ${snippet.keywords.map((k) => sanitizeForPdf(k)).join(", ")}`);
    }

    if (tagItems.length > 0) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(...C_MUTED);
      doc.text(tagItems.join("   |   "), this.margin + 2, this.cursorY + 4);
      this.cursorY += 12;
    }

    // Code block header bar
    this.ensureSpace(35);
    const lines = (snippet.content || "").replace(/\t/g, "  ").split("\n");
    const charCount = snippet.content ? snippet.content.length : 0;

    doc.setFillColor(...C_CODE_HEADER);
    doc.setDrawColor(...C_CARD_BORDER);
    doc.setLineWidth(0.6);
    doc.rect(this.margin, this.cursorY, contentW, 16, "FD");

    doc.setFont("courier", "bold");
    doc.setFontSize(7);
    doc.setTextColor(...C_DARK);
    doc.text(`${(snippet.language || "text").toUpperCase()} SOURCE`, this.margin + 6, this.cursorY + 11);

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...C_MUTED);
    const statsText = `${lines.length} lines  ·  ${charCount.toLocaleString()} chars`;
    doc.text(statsText, this.pageWidth - this.margin - 6, this.cursorY + 11, { align: "right" });

    this.cursorY += 16;

    // Code body rendered as plain table for robust auto-pagination and line numbering
    const codeRows = lines.map((line, idx) => [
      String(idx + 1),
      line.length === 0 ? " " : sanitizeForPdf(line),
    ]);

    autoTable(this.doc, {
      startY: this.cursorY,
      margin: { left: this.margin, right: this.margin },
      theme: "plain",
      styles: {
        font: "courier",
        fontSize: 7.5,
        cellPadding: { top: 1.6, bottom: 1.6, left: 4, right: 4 },
        textColor: [30, 41, 59],
        lineColor: C_CARD_BORDER,
        lineWidth: 0,
      },
      columnStyles: {
        0: {
          cellWidth: 26,
          halign: "right",
          textColor: C_FAINT,
        },
        1: {
          cellWidth: contentW - 26,
          textColor: [30, 41, 59],
        },
      },
      willDrawCell: (data) => {
        // Subtle background fill for code block
        doc.setFillColor(250, 251, 253);
        doc.rect(data.cell.x, data.cell.y, data.cell.width, data.cell.height, "F");
      },
      didDrawCell: (data) => {
        // Draw vertical separator between line numbers and code
        if (data.column.index === 0) {
          doc.setDrawColor(226, 232, 240);
          doc.setLineWidth(0.5);
          doc.line(data.cell.x + data.cell.width, data.cell.y, data.cell.x + data.cell.width, data.cell.y + data.cell.height);
        }
      },
      head: [],
      body: codeRows,
    });

    const finalY = (this.doc as any).lastAutoTable?.finalY;
    this.cursorY = finalY ? finalY + 18 : this.cursorY + 24;
  }

  finalizeAndGetArrayBuffer(): ArrayBuffer {
    const doc = this.doc;
    const totalPages = doc.getNumberOfPages();

    for (let i = 1; i <= totalPages; i++) {
      doc.setPage(i);

      // Footer divider line
      doc.setDrawColor(...C_CARD_BORDER);
      doc.setLineWidth(0.6);
      const footerY = this.pageHeight - this.margin + 12;
      doc.line(this.margin, footerY - 8, this.pageWidth - this.margin, footerY - 8);

      // Running footer branding
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7.5);
      doc.setTextColor(...C_MUTED);
      doc.text("SnippetBox  ·  Personal Text & Markdown Snippet Manager", this.margin, footerY + 2);

      // Page numbering
      doc.text(`Page ${i} of ${totalPages}`, this.pageWidth - this.margin, footerY + 2, { align: "right" });
    }

    return doc.output("arraybuffer");
  }
}

/**
 * Main entry point for generating a styled PDF document from a collection of snippets
 */
export async function generateSnippetsPdf(
  snippets: Snippet[],
  collections: Collection[],
  customTitle?: string,
  onProgress?: (current: number, total: number, title: string) => void
): Promise<ArrayBuffer> {
  const collectionsMap = new Map<string, Collection>();
  for (const c of collections) {
    collectionsMap.set(c.id, c);
  }

  const isSingle = snippets.length === 1;
  const docTitle = customTitle || (isSingle ? snippets[0].title || "Snippet Export" : "Snippets Archive Export");
  const docSubtitle = isSingle
    ? `Single snippet export (${(snippets[0].language || "text").toUpperCase()})`
    : `Comprehensive export of ${snippets.length} snippets across collections`;

  const builder = new SnippetPdfBuilder(docTitle, docSubtitle);

  // Collect summary metrics
  const uniqueLanguages = new Set(snippets.map((s) => (s.language || "text").toLowerCase())).size;
  const uniqueCollections = new Set(snippets.map((s) => s.collectionId)).size;
  const totalLines = snippets.reduce((acc, s) => acc + (s.content ? s.content.split("\n").length : 0), 0);

  // Metadata pills
  const pills = [
    { label: "Total Snippets", value: String(snippets.length) },
    { label: "Languages", value: String(uniqueLanguages) },
    { label: "Collections", value: String(uniqueCollections) },
  ];

  builder.drawHeader(pills, snippets.length);

  // KPI summary cards
  builder.drawKpis([
    { label: "Total Snippets", value: String(snippets.length), color: "indigo" },
    { label: "Total Lines", value: totalLines.toLocaleString(), color: "mint" },
    { label: "Languages", value: String(uniqueLanguages), color: "neutral" },
    { label: "Collections", value: String(uniqueCollections), color: "neutral" },
  ]);

  // If multiple snippets, draw a neat summary index table
  if (snippets.length > 1) {
    builder.drawSummaryTable(snippets, collectionsMap);
  }

  // Draw each snippet in order
  for (let i = 0; i < snippets.length; i++) {
    const s = snippets[i];
    if (onProgress) {
      onProgress(i + 1, snippets.length, s.title || "Untitled");
    }
    const col = collectionsMap.get(s.collectionId);
    builder.drawSnippet(s, col, snippets.length > 1 ? i + 1 : undefined, snippets.length);
  }

  return builder.finalizeAndGetArrayBuffer();
}
