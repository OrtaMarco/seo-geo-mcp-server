/**
 * Content analysis: heading outline, readability, word counts and image SEO.
 */

import { HEAVY_HTML_BYTES, THIN_CONTENT_WORDS } from "../constants.js";
import { clampScore, scoreToGrade, type Finding } from "../format.js";
import { mainText, resolveUrl, type PageDoc } from "./page.js";

// --- headings --------------------------------------------------------------

export interface Heading {
  level: number;
  text: string;
  /** True when this heading skips a level relative to the previous one. */
  skips_level: boolean;
}

export interface HeadingReport {
  url: string;
  final_url: string;
  headings: Heading[];
  h1_count: number;
  h1_text: string[];
  /** Levels jumped, e.g. an h2 followed directly by an h4. */
  level_skips: number;
  empty_headings: number;
  /** Headings phrased as questions — a strong GEO signal. */
  question_headings: string[];
  outline: string;
  score: number;
  grade: string;
  findings: Finding[];
}

/** Question-shaped headings, in the languages this server is used for most. */
const QUESTION_RE =
  /^\s*(?:¿|what|how|why|when|where|which|who|can|should|do|does|is|are|will|qué|que|cómo|como|por qué|porque|cuándo|cuando|dónde|donde|cuál|cual|quién|quien|puedo|puede|debo|es|son)\b|\?\s*$/i;

export function analyzeHeadings(page: PageDoc): HeadingReport {
  const $ = page.$;
  const findings: Finding[] = [];
  const headings: Heading[] = [];

  let previousLevel = 0;
  let levelSkips = 0;
  let emptyHeadings = 0;

  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tagName = (el as { tagName?: string }).tagName ?? "h1";
    const level = Number.parseInt(tagName.slice(1), 10);
    const text = $(el).text().replace(/\s+/g, " ").trim();

    if (!text) {
      emptyHeadings++;
      return;
    }

    // A skip is only meaningful going *down* the hierarchy (h2 → h4).
    const skips = previousLevel > 0 && level > previousLevel + 1;
    if (skips) levelSkips++;

    headings.push({ level, text, skips_level: skips });
    previousLevel = level;
  });

  const h1s = headings.filter((h) => h.level === 1);
  const questionHeadings = headings
    .filter((h) => QUESTION_RE.test(h.text))
    .map((h) => h.text);

  let score = 0;

  if (h1s.length === 0) {
    findings.push({ severity: "fail", message: "No <h1>. Every page needs exactly one — it is the primary topic signal for both search and AI extraction." });
  } else if (h1s.length === 1) {
    score += 40;
    findings.push({ severity: "pass", message: `Exactly one <h1>: "${h1s[0]!.text}".` });
  } else {
    score += 20;
    findings.push({ severity: "warn", message: `${h1s.length} <h1> tags. HTML5 permits it, but a single h1 states the page topic far more clearly.` });
  }

  if (headings.length < 2) {
    findings.push({ severity: "warn", message: "Almost no headings. Subheadings are what let AI answer engines pull a coherent passage out of your page." });
  } else {
    score += 25;
    findings.push({ severity: "pass", message: `${headings.length} headings give the page a scannable structure.` });
  }

  if (levelSkips === 0) {
    score += 20;
    findings.push({ severity: "pass", message: "Heading hierarchy is well-formed (no skipped levels)." });
  } else {
    score += 8;
    findings.push({ severity: "warn", message: `${levelSkips} skipped heading level(s) (e.g. an h2 followed by an h4). Fix for accessibility and cleaner machine parsing.` });
  }

  if (emptyHeadings) {
    findings.push({ severity: "warn", message: `${emptyHeadings} empty heading tag(s) — usually a styling hack. Remove them or add text.` });
  } else {
    score += 5;
  }

  if (questionHeadings.length) {
    score += 10;
    findings.push({ severity: "pass", message: `${questionHeadings.length} heading(s) are phrased as questions — this maps directly onto how people prompt AI assistants.` });
  } else {
    findings.push({ severity: "info", message: "No question-shaped headings. Phrasing some subheads as the questions your audience actually asks improves both featured-snippet and AI-citation odds." });
  }

  const outline = headings
    .map((h) => `${"  ".repeat(Math.max(0, h.level - 1))}h${h.level}: ${h.text}`)
    .join("\n");

  return {
    url: page.url,
    final_url: page.finalUrl,
    headings,
    h1_count: h1s.length,
    h1_text: h1s.map((h) => h.text),
    level_skips: levelSkips,
    empty_headings: emptyHeadings,
    question_headings: questionHeadings,
    outline,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}

// --- readability & word counts --------------------------------------------

export interface ContentReport {
  url: string;
  final_url: string;
  word_count: number;
  sentence_count: number;
  paragraph_count: number;
  avg_words_per_sentence: number;
  /** Flesch Reading Ease: 0–100, higher is easier. */
  reading_ease: number;
  reading_level: string;
  /** Approximate minutes to read at 220 wpm. */
  reading_time_minutes: number;
  thin_content: boolean;
  /** Ratio of visible text to raw HTML — low values suggest bloat. */
  text_to_html_ratio: number;
  html_bytes: number;
  /** Whether a <main>/<article> landmark was found and used. */
  used_content_landmark: boolean;
  top_terms: Array<{ term: string; count: number; density: number }>;
  score: number;
  grade: string;
  findings: Finding[];
}

/** Stop words excluded from keyword density, English + Spanish. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one",
  "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old",
  "see", "two", "who", "did", "yes", "his", "from", "they", "she", "will", "with", "this",
  "that", "have", "been", "were", "their", "what", "when", "your", "more", "some", "them",
  "than", "then", "into", "just", "over", "also", "only", "such", "most", "even", "much",
  "una", "uno", "los", "las", "del", "por", "para", "con", "sin", "sus", "que", "como",
  "más", "pero", "este", "esta", "esto", "esos", "esas", "todo", "toda", "todos", "todas",
  "ser", "son", "está", "están", "hay", "muy", "eso", "ese", "esa", "sobre", "entre",
  "cuando", "donde", "porque", "desde", "hasta", "también", "puede", "hacer", "otro",
]);

function fleschReadingEase(words: number, sentences: number, syllables: number): number {
  if (words === 0 || sentences === 0) return 0;
  return 206.835 - 1.015 * (words / sentences) - 84.6 * (syllables / words);
}

/**
 * Approximate syllable count. Vowel-group counting is crude but stable enough
 * for a relative readability signal, and works acceptably for both English and
 * Spanish (Spanish is more phonetically regular, so it errs low, not wildly).
 */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-záéíóúüñ]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouyáéíóúü]+/g);
  let count = groups ? groups.length : 1;
  // Silent trailing "e" in English.
  if (w.length > 2 && w.endsWith("e") && !/[aeiouy]e$/.test(w)) count--;
  return Math.max(1, count);
}

function readingLevel(score: number): string {
  if (score >= 90) return "very easy (5th grade)";
  if (score >= 80) return "easy (6th grade)";
  if (score >= 70) return "fairly easy (7th grade)";
  if (score >= 60) return "plain English (8th–9th grade)";
  if (score >= 50) return "fairly difficult (10th–12th grade)";
  if (score >= 30) return "difficult (university)";
  return "very difficult (graduate)";
}

export function analyzeContent(page: PageDoc): ContentReport {
  const findings: Finding[] = [];
  const { text, usedLandmark } = mainText(page);

  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const wordCount = words.length;
  const sentences = text.split(/[.!?¿¡]+(?:\s|$)/).filter((s) => s.trim().length > 0);
  const sentenceCount = Math.max(1, sentences.length);
  const paragraphCount = page.$("p").length;

  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);
  const readingEase = Math.round(fleschReadingEase(wordCount, sentenceCount, syllables) * 10) / 10;
  const avgWordsPerSentence = Math.round((wordCount / sentenceCount) * 10) / 10;

  // --- keyword density
  const frequencies = new Map<string, number>();
  for (const raw of words) {
    const term = raw.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
    if (term.length < 4 || STOP_WORDS.has(term)) continue;
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  const topTerms = [...frequencies.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([term, count]) => ({
      term,
      count,
      density: Math.round((count / Math.max(1, wordCount)) * 10000) / 100,
    }));

  const textBytes = Buffer.byteLength(text, "utf8");
  const textToHtmlRatio =
    page.bytes > 0 ? Math.round((textBytes / page.bytes) * 1000) / 10 : 0;

  const thinContent = wordCount < THIN_CONTENT_WORDS;

  let score = 0;

  if (thinContent) {
    findings.push({ severity: "warn", message: `Only ${wordCount} words of main content. Below ~${THIN_CONTENT_WORDS} a page rarely has enough substance to rank or to be cited by an AI assistant.` });
    score += 10;
  } else {
    score += 35;
    findings.push({ severity: "pass", message: `${wordCount} words of main content — enough depth to cover a topic properly.` });
  }

  if (!usedLandmark) {
    findings.push({ severity: "warn", message: "No <main> or <article> landmark. Adding one tells parsers (and AI extractors) exactly which part of the page is the content." });
  } else {
    score += 15;
    findings.push({ severity: "pass", message: "Main content is wrapped in a semantic landmark." });
  }

  if (readingEase >= 50) {
    score += 20;
    findings.push({ severity: "pass", message: `Flesch reading ease ${readingEase} — ${readingLevel(readingEase)}.` });
  } else {
    score += 8;
    findings.push({ severity: "warn", message: `Flesch reading ease ${readingEase} — ${readingLevel(readingEase)}. Shorter sentences and plainer words make passages easier to quote.` });
  }

  if (avgWordsPerSentence > 25) {
    findings.push({ severity: "warn", message: `Sentences average ${avgWordsPerSentence} words. Long sentences are harder for AI models to extract as self-contained answers.` });
  } else {
    score += 15;
  }

  if (paragraphCount < 3 && wordCount > 200) {
    findings.push({ severity: "warn", message: "Very few <p> elements for this much text — content may be in <div>s, which parses worse." });
  } else {
    score += 10;
  }

  if (textToHtmlRatio < 5 && page.bytes > 50_000) {
    findings.push({ severity: "warn", message: `Text is only ${textToHtmlRatio}% of the HTML payload. Heavy markup slows rendering and dilutes the content signal.` });
  } else {
    score += 5;
  }

  if (page.bytes > HEAVY_HTML_BYTES) {
    findings.push({ severity: "warn", message: `HTML document is ${Math.round(page.bytes / 1024)} KB — above the ~${Math.round(HEAVY_HTML_BYTES / 1024)} KB comfort threshold. Large documents delay first paint.` });
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    word_count: wordCount,
    sentence_count: sentenceCount,
    paragraph_count: paragraphCount,
    avg_words_per_sentence: avgWordsPerSentence,
    reading_ease: readingEase,
    reading_level: readingLevel(readingEase),
    reading_time_minutes: Math.max(1, Math.round(wordCount / 220)),
    thin_content: thinContent,
    text_to_html_ratio: textToHtmlRatio,
    html_bytes: page.bytes,
    used_content_landmark: usedLandmark,
    top_terms: topTerms,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}

// --- images ----------------------------------------------------------------

export interface ImageIssue {
  src: string;
  missing_alt: boolean;
  empty_alt: boolean;
  missing_dimensions: boolean;
  lazy_loaded: boolean;
  /** True for modern formats (webp/avif). */
  modern_format: boolean;
}

export interface ImageReport {
  url: string;
  final_url: string;
  total_images: number;
  missing_alt: number;
  decorative_alt: number;
  missing_dimensions: number;
  lazy_loaded: number;
  modern_format: number;
  legacy_format: number;
  images: ImageIssue[];
  score: number;
  grade: string;
  findings: Finding[];
}

export function analyzeImages(page: PageDoc, maxListed = 50): ImageReport {
  const $ = page.$;
  const findings: Finding[] = [];
  const images: ImageIssue[] = [];

  $("img").each((_, el) => {
    const node = $(el);
    const src = node.attr("src") ?? node.attr("data-src") ?? "";
    if (!src) return;

    const alt = node.attr("alt");
    const absolute = resolveUrl(page, src)?.toString() ?? src;
    const extension = /\.(\w{2,5})(?:[?#]|$)/.exec(absolute)?.[1]?.toLowerCase() ?? "";

    images.push({
      src: absolute,
      missing_alt: alt === undefined,
      empty_alt: alt !== undefined && alt.trim() === "",
      missing_dimensions: !node.attr("width") || !node.attr("height"),
      lazy_loaded: node.attr("loading") === "lazy",
      modern_format: ["webp", "avif"].includes(extension),
    });
  });

  // <picture> sources count as modern-format delivery even when the <img>
  // fallback is a jpeg.
  const pictureSources = $("picture source[type]")
    .toArray()
    .map((el) => $(el).attr("type") ?? "")
    .filter((t) => /image\/(webp|avif)/i.test(t)).length;

  const missingAlt = images.filter((i) => i.missing_alt).length;
  const decorativeAlt = images.filter((i) => i.empty_alt).length;
  const missingDimensions = images.filter((i) => i.missing_dimensions).length;
  const lazyLoaded = images.filter((i) => i.lazy_loaded).length;
  const modernFormat = images.filter((i) => i.modern_format).length;
  const legacyFormat = images.length - modernFormat;

  let score = 0;

  if (images.length === 0) {
    findings.push({ severity: "info", message: "No <img> elements found. Nothing to check — but images help both engagement and image search." });
    return {
      url: page.url,
      final_url: page.finalUrl,
      total_images: 0,
      missing_alt: 0,
      decorative_alt: 0,
      missing_dimensions: 0,
      lazy_loaded: 0,
      modern_format: 0,
      legacy_format: 0,
      images: [],
      score: 100,
      grade: "A",
      findings,
    };
  }

  if (missingAlt === 0) {
    score += 45;
    findings.push({ severity: "pass", message: `All ${images.length} images have an alt attribute (${decorativeAlt} marked decorative with alt="").` });
  } else {
    score += Math.round(45 * (1 - missingAlt / images.length));
    findings.push({ severity: "fail", message: `${missingAlt} of ${images.length} images have no alt attribute. Alt text is required for accessibility and is how image search understands the file.` });
  }

  if (missingDimensions === 0) {
    score += 25;
    findings.push({ severity: "pass", message: "All images declare width and height — no layout shift from images." });
  } else {
    score += Math.round(25 * (1 - missingDimensions / images.length));
    findings.push({ severity: "warn", message: `${missingDimensions} image(s) lack width/height attributes, which causes cumulative layout shift (a Core Web Vitals factor).` });
  }

  if (modernFormat + pictureSources > 0) {
    score += 20;
    findings.push({ severity: "pass", message: `${modernFormat + pictureSources} image(s) use WebP/AVIF.` });
  }
  if (legacyFormat > 0 && pictureSources === 0) {
    findings.push({ severity: "warn", message: `${legacyFormat} image(s) use legacy formats (JPEG/PNG/GIF). WebP or AVIF typically cuts 25–50% of the bytes.` });
  }

  if (lazyLoaded > 0) {
    score += 10;
    findings.push({ severity: "pass", message: `${lazyLoaded} image(s) use loading="lazy".` });
  } else if (images.length > 5) {
    findings.push({ severity: "warn", message: 'No images use loading="lazy". Add it to below-the-fold images — but never to your LCP hero image.' });
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    total_images: images.length,
    missing_alt: missingAlt,
    decorative_alt: decorativeAlt,
    missing_dimensions: missingDimensions,
    lazy_loaded: lazyLoaded,
    modern_format: modernFormat,
    legacy_format: legacyFormat,
    images: images.slice(0, maxListed),
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}
