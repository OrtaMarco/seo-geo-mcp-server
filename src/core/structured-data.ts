/**
 * Structured-data extraction and validation (JSON-LD, microdata, RDFa).
 *
 * Requirement tables follow Google's rich-result documentation: `required`
 * properties are those Google lists as required for eligibility, `recommended`
 * are the ones that measurably improve the rendered result. Types absent from
 * the table are still reported — they just are not scored against a checklist.
 */

import { clampScore, scoreToGrade, type Finding } from "../format.js";
import type { PageDoc } from "./page.js";

interface TypeSpec {
  required: string[];
  recommended: string[];
  note?: string;
}

/** Google rich-result requirements, keyed by schema.org @type. */
const TYPE_SPECS: Record<string, TypeSpec> = {
  Article: {
    required: ["headline"],
    recommended: ["image", "datePublished", "dateModified", "author"],
    note: "Article rich results need an author and dates to show attribution.",
  },
  BlogPosting: {
    required: ["headline"],
    recommended: ["image", "datePublished", "dateModified", "author"],
  },
  NewsArticle: {
    required: ["headline"],
    recommended: ["image", "datePublished", "dateModified", "author"],
  },
  Product: {
    required: ["name"],
    recommended: ["image", "description", "offers", "aggregateRating", "review", "brand"],
    note: "Without `offers` a Product cannot show price or availability in results.",
  },
  FAQPage: {
    required: ["mainEntity"],
    recommended: [],
    note: "Each mainEntity must be a Question with an acceptedAnswer.",
  },
  QAPage: {
    required: ["mainEntity"],
    recommended: [],
  },
  HowTo: {
    required: ["name", "step"],
    recommended: ["image", "totalTime", "supply", "tool"],
  },
  Recipe: {
    required: ["name", "image"],
    recommended: ["author", "datePublished", "recipeIngredient", "recipeInstructions", "nutrition", "aggregateRating"],
  },
  Event: {
    required: ["name", "startDate", "location"],
    recommended: ["image", "description", "endDate", "offers", "performer"],
  },
  Organization: {
    required: ["name"],
    recommended: ["url", "logo", "sameAs", "contactPoint", "description"],
    note: "sameAs links to official social profiles are what tie your entity together in knowledge graphs.",
  },
  LocalBusiness: {
    required: ["name", "address"],
    recommended: ["telephone", "openingHoursSpecification", "geo", "priceRange", "image"],
  },
  Person: {
    required: ["name"],
    recommended: ["url", "jobTitle", "sameAs", "image", "worksFor"],
  },
  WebSite: {
    required: ["name", "url"],
    recommended: ["potentialAction"],
    note: "A `potentialAction` SearchAction enables the sitelinks search box.",
  },
  WebPage: {
    required: [],
    recommended: ["name", "description", "datePublished", "dateModified", "breadcrumb"],
  },
  BreadcrumbList: {
    required: ["itemListElement"],
    recommended: [],
  },
  VideoObject: {
    required: ["name", "thumbnailUrl", "uploadDate"],
    recommended: ["description", "duration", "contentUrl", "embedUrl"],
  },
  SoftwareApplication: {
    required: ["name"],
    recommended: ["applicationCategory", "operatingSystem", "offers", "aggregateRating"],
  },
  Course: {
    required: ["name", "description"],
    recommended: ["provider", "offers", "hasCourseInstance"],
  },
  JobPosting: {
    required: ["title", "description", "datePosted", "hiringOrganization", "jobLocation"],
    recommended: ["baseSalary", "employmentType", "validThrough"],
  },
  Review: {
    required: ["itemReviewed", "reviewRating", "author"],
    recommended: ["datePublished", "reviewBody"],
  },
  AggregateRating: {
    required: ["ratingValue"],
    recommended: ["reviewCount", "ratingCount", "bestRating"],
  },
};

/**
 * Schema.org subtypes that ARE an Organization for entity-recognition purposes.
 *
 * Matching only the literal strings "Organization" and "LocalBusiness" produces
 * false negatives on every site that uses a precise subtype — an accountancy
 * marked up as `AccountingService` (→ FinancialService → LocalBusiness →
 * Organization) is doing it *more* correctly, not less.
 */
const ORGANIZATION_TYPES = new Set(
  [
    "Organization", "LocalBusiness", "Corporation", "NGO", "OnlineBusiness",
    "EducationalOrganization", "GovernmentOrganization", "MedicalOrganization",
    "NewsMediaOrganization", "PerformingGroup", "ResearchOrganization",
    "SportsOrganization", "Airline", "Consortium", "LibrarySystem", "WorkersUnion",
    // LocalBusiness subtypes
    "AccountingService", "FinancialService", "LegalService", "ProfessionalService",
    "Store", "Restaurant", "MedicalBusiness", "HomeAndConstructionBusiness",
    "AutomotiveBusiness", "ChildCare", "Dentist", "DryCleaningOrLaundry",
    "EmergencyService", "EmploymentAgency", "EntertainmentBusiness",
    "FoodEstablishment", "GovernmentOffice", "HealthAndBeautyBusiness",
    "InsuranceAgency", "InternetCafe", "Library", "LodgingBusiness",
    "RadioStation", "RealEstateAgent", "RecyclingCenter", "SelfStorage",
    "ShoppingCenter", "SportsActivityLocation", "TelevisionStation",
    "TouristInformationCenter", "TravelAgency", "Notary", "TaxPreparation",
    "BankOrCreditUnion", "AutoRepair", "Plumber", "Electrician",
  ].map((t) => t.toLowerCase()),
);

/** Article-family types, for which an `author` is genuinely expected. */
const ARTICLE_TYPES = new Set(
  ["Article", "BlogPosting", "NewsArticle", "TechArticle", "ScholarlyArticle", "Report"].map(
    (t) => t.toLowerCase(),
  ),
);

/** True when any of `types` is an Organization or one of its subtypes. */
export function isOrganizationType(types: string[]): boolean {
  return types.some((t) => ORGANIZATION_TYPES.has(t.toLowerCase()));
}

/** True when any of `types` is an Article-family type. */
export function isArticleType(types: string[]): boolean {
  return types.some((t) => ARTICLE_TYPES.has(t.toLowerCase()));
}

export interface StructuredDataItem {
  format: "json-ld" | "microdata" | "rdfa";
  type: string;
  all_types: string[];
  properties: string[];
  missing_required: string[];
  missing_recommended: string[];
  valid: boolean;
  note: string | null;
}

export interface StructuredDataReport {
  url: string;
  final_url: string;
  json_ld_blocks: number;
  microdata_items: number;
  rdfa_items: number;
  parse_errors: string[];
  items: StructuredDataItem[];
  types_found: string[];
  has_organization: boolean;
  /** A Person entity — the correct publisher markup for a personal brand. */
  has_person: boolean;
  has_website: boolean;
  has_breadcrumb: boolean;
  has_article: boolean;
  has_faq: boolean;
  score: number;
  grade: string;
  findings: Finding[];
}

/** Normalise a `@type` value, which may be a string or an array. */
function typeNames(value: unknown): string[] {
  if (typeof value === "string") return [value.replace(/^https?:\/\/schema\.org\//i, "")];
  if (Array.isArray(value)) return value.flatMap(typeNames);
  return [];
}

/**
 * Walk a parsed JSON-LD value and yield every node that declares an `@type`,
 * flattening `@graph` containers and arrays.
 */
function* walkNodes(value: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(value)) {
    for (const entry of value) yield* walkNodes(entry);
    return;
  }
  if (!value || typeof value !== "object") return;

  const node = value as Record<string, unknown>;
  if ("@graph" in node) {
    yield* walkNodes(node["@graph"]);
    // A node can carry both @graph and its own @type.
  }
  if ("@type" in node) yield node;
}

function evaluateNode(
  node: Record<string, unknown>,
  format: StructuredDataItem["format"],
): StructuredDataItem {
  const types = typeNames(node["@type"]);
  const primary = types[0] ?? "Unknown";
  const properties = Object.keys(node).filter((k) => !k.startsWith("@"));

  // Match the spec on any declared type, not just the first.
  const specType = types.find((t) => t in TYPE_SPECS);
  const spec = specType ? TYPE_SPECS[specType] : undefined;

  const present = new Set(properties);
  const missingRequired = spec ? spec.required.filter((p) => !present.has(p)) : [];
  const missingRecommended = spec ? spec.recommended.filter((p) => !present.has(p)) : [];

  return {
    format,
    type: primary,
    all_types: types,
    properties,
    missing_required: missingRequired,
    missing_recommended: missingRecommended,
    valid: missingRequired.length === 0,
    note: spec?.note ?? null,
  };
}

export function analyzeStructuredData(page: PageDoc): StructuredDataReport {
  const $ = page.$;
  const findings: Finding[] = [];
  const items: StructuredDataItem[] = [];
  const parseErrors: string[] = [];

  // --- JSON-LD
  const scripts = $('script[type="application/ld+json" i]');
  scripts.each((index, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) {
      parseErrors.push(`JSON-LD block ${index + 1} is empty.`);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      let found = 0;
      for (const node of walkNodes(parsed)) {
        items.push(evaluateNode(node, "json-ld"));
        found++;
      }
      if (found === 0) {
        parseErrors.push(`JSON-LD block ${index + 1} parsed but declares no @type.`);
      }
    } catch (err) {
      parseErrors.push(
        `JSON-LD block ${index + 1} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  // --- microdata
  const microdataItems = $("[itemscope][itemtype]");
  microdataItems.each((_, el) => {
    const itemType = $(el).attr("itemtype") ?? "";
    const properties = $(el)
      .find("[itemprop]")
      .toArray()
      .map((child) => $(child).attr("itemprop") ?? "")
      .filter(Boolean);
    items.push(
      evaluateNode(
        {
          "@type": itemType.replace(/^https?:\/\/schema\.org\//i, ""),
          ...Object.fromEntries(properties.map((p) => [p, true])),
        },
        "microdata",
      ),
    );
  });

  // --- RDFa (presence only — full RDFa parsing is out of scope)
  const rdfaItems = $("[typeof]").length;

  const typesFound = [...new Set(items.flatMap((i) => i.all_types))];
  const hasType = (needle: string) =>
    items.some((i) => i.all_types.some((t) => t.toLowerCase() === needle.toLowerCase()));

  const hasOrganization = isOrganizationType(typesFound);
  const hasWebsite = hasType("WebSite");
  const hasBreadcrumb = hasType("BreadcrumbList");
  const hasArticle = isArticleType(typesFound);
  const hasFaq = hasType("FAQPage");
  const hasPerson = hasType("Person");

  // --- scoring
  let score = 0;

  if (items.length === 0) {
    findings.push({
      severity: "fail",
      message:
        "No structured data found. Schema markup is the most reliable way to state facts about your page in a form both search engines and AI models parse without guessing.",
    });
  } else {
    score += 35;
    findings.push({
      severity: "pass",
      message: `${items.length} structured-data item(s) found: ${typesFound.join(", ")}.`,
    });
  }

  const invalid = items.filter((i) => !i.valid);
  if (invalid.length) {
    findings.push({
      severity: "fail",
      message: `${invalid.length} item(s) are missing required properties: ${invalid
        .map((i) => `${i.type} (needs ${i.missing_required.join(", ")})`)
        .join("; ")}.`,
    });
  } else if (items.length) {
    score += 25;
    findings.push({ severity: "pass", message: "All recognised items have their required properties." });
  }

  const withMissingRecommended = items.filter((i) => i.missing_recommended.length);
  if (withMissingRecommended.length) {
    findings.push({
      severity: "warn",
      message: `Recommended properties absent: ${withMissingRecommended
        .map((i) => `${i.type} (${i.missing_recommended.join(", ")})`)
        .join("; ")}.`,
    });
  } else if (items.length) {
    score += 10;
  }

  if (parseErrors.length) {
    findings.push({
      severity: "fail",
      message: `${parseErrors.length} structured-data block(s) failed to parse — they are invisible to search engines. ${parseErrors.join(" ")}`,
    });
  }

  // A Person entity is the correct publisher markup for a personal brand, so it
  // satisfies this check just as an Organization does.
  const orgType = typesFound.find((t) => isOrganizationType([t]));
  if (hasOrganization) {
    score += 10;
    findings.push({ severity: "pass", message: `Publisher entity present (${orgType}) — this is what builds your entity in knowledge graphs.` });
  } else if (hasPerson) {
    score += 10;
    findings.push({ severity: "pass", message: "Person entity present — the correct publisher markup for a personal brand." });
  } else {
    findings.push({ severity: "warn", message: "No publisher entity (Organization, one of its subtypes, or Person). Add one with `sameAs` links to your official profiles so AI systems can resolve who publishes this site." });
  }

  if (hasBreadcrumb) {
    score += 10;
    findings.push({ severity: "pass", message: "BreadcrumbList present — improves how the URL renders in results." });
  } else {
    findings.push({ severity: "info", message: "No BreadcrumbList markup. It clarifies site hierarchy and replaces the raw URL in search results." });
  }

  if (hasWebsite) score += 5;
  if (hasArticle) score += 5;

  for (const item of items) {
    if (item.note && (item.missing_required.length || item.missing_recommended.length)) {
      findings.push({ severity: "info", message: `${item.type}: ${item.note}` });
    }
  }

  return {
    url: page.url,
    final_url: page.finalUrl,
    json_ld_blocks: scripts.length,
    microdata_items: microdataItems.length,
    rdfa_items: rdfaItems,
    parse_errors: parseErrors,
    items,
    types_found: typesFound,
    has_organization: hasOrganization,
    has_person: hasPerson,
    has_website: hasWebsite,
    has_breadcrumb: hasBreadcrumb,
    has_article: hasArticle,
    has_faq: hasFaq,
    score: clampScore(score),
    grade: scoreToGrade(clampScore(score)),
    findings,
  };
}
