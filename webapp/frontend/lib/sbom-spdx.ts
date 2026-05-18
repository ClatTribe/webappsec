// CycloneDX → SPDX converter.
//
// Procurement teams ask for whichever format their existing pipeline
// consumes. Most modern tooling speaks CycloneDX (which is what the
// engine emits natively); some Linux Foundation / government
// pipelines require SPDX 2.3 instead.
//
// We don't try to round-trip every CycloneDX field — SPDX has a
// different scope ("software bill of materials" vs CycloneDX's more
// general "everything detected"). The mapping below covers the
// fields procurement actually reviews: name, version, package URL
// (purl), supplier, license, downloadLocation, copyright. Anything
// else lands as a `comment` on the SPDX package so no data is lost.

interface CycloneDxComponent {
  'bom-ref'?: string;
  type?: string;
  name?: string;
  version?: string;
  purl?: string;
  licenses?: Array<{
    license?: { id?: string; name?: string };
    expression?: string;
  }>;
  supplier?: { name?: string };
  description?: string;
  scope?: string;
  hashes?: Array<{ alg?: string; content?: string }>;
}

interface CycloneDxBom {
  bomFormat?: string;
  specVersion?: string;
  serialNumber?: string;
  version?: number;
  metadata?: {
    timestamp?: string;
    component?: { name?: string };
  };
  components?: CycloneDxComponent[];
}

interface SpdxPackage {
  SPDXID: string;
  name: string;
  versionInfo?: string;
  packageFileName?: string;
  supplier: string;
  downloadLocation: string;
  filesAnalyzed: false;
  homepage?: string;
  licenseConcluded: string;
  licenseDeclared: string;
  copyrightText: string;
  externalRefs?: Array<{
    referenceCategory: string;
    referenceType: string;
    referenceLocator: string;
  }>;
  comment?: string;
  checksums?: Array<{ algorithm: string; checksumValue: string }>;
}

interface SpdxDocument {
  spdxVersion: 'SPDX-2.3';
  dataLicense: 'CC0-1.0';
  SPDXID: 'SPDXRef-DOCUMENT';
  name: string;
  documentNamespace: string;
  creationInfo: {
    creators: string[];
    created: string;
  };
  packages: SpdxPackage[];
  relationships: Array<{
    spdxElementId: string;
    relationshipType: string;
    relatedSpdxElement: string;
  }>;
}

/** Convert a CycloneDX 1.4 / 1.5 BOM into an SPDX 2.3 document. */
export function cycloneDxToSpdx(
  bom: CycloneDxBom,
  args: { documentName: string; documentNamespace: string },
): SpdxDocument {
  const timestamp =
    bom.metadata?.timestamp ?? new Date().toISOString();

  const packages: SpdxPackage[] = (bom.components ?? []).map((c, i) => {
    // SPDX requires a stable SPDXID per element. We prefer the BOM's
    // bom-ref when present, falling back to a synthetic counter for
    // components missing one.
    const spdxId = (c['bom-ref'] ?? `SPDXRef-Package-${i + 1}`)
      .replace(/[^A-Za-z0-9.-]/g, '-')
      .replace(/^-+|-+$/g, '');
    const safeId = `SPDXRef-${spdxId.startsWith('SPDXRef-') ? spdxId.slice(8) : spdxId}`;

    // Licenses: SPDX prefers single-license-id strings. CycloneDX can
    // express SPDX expressions or named licenses. We take the first
    // legible value; fall back to NOASSERTION.
    const license =
      c.licenses?.[0]?.license?.id ??
      c.licenses?.[0]?.expression ??
      c.licenses?.[0]?.license?.name ??
      'NOASSERTION';

    const supplier =
      c.supplier?.name && c.supplier.name.length > 0
        ? `Organization: ${c.supplier.name}`
        : 'NOASSERTION';

    const externalRefs: SpdxPackage['externalRefs'] = [];
    if (c.purl) {
      externalRefs.push({
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: c.purl,
      });
    }

    const checksums = (c.hashes ?? [])
      .filter((h) => h.alg && h.content)
      .map((h) => ({
        algorithm: spdxAlgorithm(h.alg!),
        checksumValue: h.content!,
      }))
      .filter((c) => c.algorithm !== 'UNKNOWN');

    return {
      SPDXID: safeId,
      name: c.name ?? 'unknown',
      versionInfo: c.version,
      supplier,
      // SPDX requires SOMETHING here; NOASSERTION is the spec-blessed
      // "we don't know" value.
      downloadLocation: c.purl ? `pkg:${c.purl}` : 'NOASSERTION',
      filesAnalyzed: false,
      licenseConcluded: license,
      licenseDeclared: license,
      copyrightText: 'NOASSERTION',
      externalRefs: externalRefs.length > 0 ? externalRefs : undefined,
      comment: c.description
        ? `description: ${c.description}; cdx_type: ${c.type ?? 'unknown'}; cdx_scope: ${c.scope ?? 'unknown'}`
        : undefined,
      checksums: checksums.length > 0 ? checksums : undefined,
    };
  });

  // SPDX requires a DESCRIBES relationship between the document and
  // a root package. We synthesise one if the CycloneDX metadata
  // carries a root component; otherwise emit DESCRIBES for every
  // top-level package so the document is at least linked.
  const rootName = bom.metadata?.component?.name;
  const rootPackage: SpdxPackage | null = rootName
    ? {
        SPDXID: 'SPDXRef-Root',
        name: rootName,
        supplier: 'NOASSERTION',
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'NOASSERTION',
        copyrightText: 'NOASSERTION',
      }
    : null;

  const relationships: SpdxDocument['relationships'] = [];
  if (rootPackage) {
    relationships.push({
      spdxElementId: 'SPDXRef-DOCUMENT',
      relationshipType: 'DESCRIBES',
      relatedSpdxElement: rootPackage.SPDXID,
    });
    for (const p of packages) {
      relationships.push({
        spdxElementId: rootPackage.SPDXID,
        relationshipType: 'DEPENDS_ON',
        relatedSpdxElement: p.SPDXID,
      });
    }
  } else {
    for (const p of packages) {
      relationships.push({
        spdxElementId: 'SPDXRef-DOCUMENT',
        relationshipType: 'DESCRIBES',
        relatedSpdxElement: p.SPDXID,
      });
    }
  }

  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: args.documentName,
    documentNamespace: args.documentNamespace,
    creationInfo: {
      creators: ['Tool: tensorshield-wrapper'],
      created: timestamp,
    },
    packages: rootPackage ? [rootPackage, ...packages] : packages,
    relationships,
  };
}

/** SPDX names a smaller set of hash algorithms than CycloneDX. */
function spdxAlgorithm(cdxAlg: string): string {
  const m: Record<string, string> = {
    'SHA-1': 'SHA1',
    'SHA-256': 'SHA256',
    'SHA-384': 'SHA384',
    'SHA-512': 'SHA512',
    MD5: 'MD5',
  };
  return m[cdxAlg.toUpperCase()] ?? m[cdxAlg] ?? 'UNKNOWN';
}
