// The identifier vocabulary of tool-result masking (src/ai/mask.ts, PIA C3): token labels and
// grammar, check digits, the value-layer detectors, and which object keys name identity fields.
// Pure and dependency-free, like the walk that uses it; the plan-P2 DSR search can import it on its
// own to generate and recognise identifier formats. What is and is not masked, and why, is the
// mask.ts header and DECISIONS 2026-09-25 "Masking tool results".
//
// The check digits follow python-stdnum's implementations for CPF, RUT, CUIT, RUC, CURP and RFC,
// and the Receita Federal's definition for the CNPJ (alphanumeric form included: each character
// counts as its code point minus 48). test/ai/mask.test.ts pins every one to values computed by an
// independent transcription of those formulas.

/** Every token label. Adding one is a reviewed change: the DSR search reads MASK_TOKEN_PATTERN. */
export const MASK_LABELS = [
  'CPF',
  'RUT',
  'CURP',
  'RFC',
  'CUIT',
  'CUIL',
  'RUC',
  'DNI',
  'SSN',
  'PASSPORT',
  'ID',
  'DOB',
  'BIRTHPLACE',
  'NATIONALITY',
  'ADDRESS',
  'PARENT',
] as const;
export type MaskLabel = (typeof MASK_LABELS)[number];

/** Regex source matching one token, `[CPF#1]`. Build with `new RegExp(MASK_TOKEN_PATTERN, 'g')`. */
export const MASK_TOKEN_PATTERN = `\\[(?:${MASK_LABELS.join('|')})#[1-9][0-9]*\\]`;

// ── Check digits (re-exported by mask.ts; the DSR search, plan P2, can use them) ─────────────────────────

function digitsOf(value: string, length: number, what: string): number[] {
  if (value.length !== length || !/^[0-9]+$/.test(value)) {
    throw new TypeError(`mask: ${what} needs exactly ${length} digits`);
  }
  return Array.from(value, Number);
}

/** Brazil CPF: the two check digits of the first nine. */
export function cpfCheckDigits(first9: string): string {
  const d = digitsOf(first9, 9, 'cpfCheckDigits');
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < 9; i++) {
    s1 += d[i]! * (10 - i);
    s2 += d[i]! * (11 - i);
  }
  const d1 = ((s1 * 10) % 11) % 10;
  const d2 = (((s2 + d1 * 2) * 10) % 11) % 10;
  return `${d1}${d2}`;
}

const CNPJ_W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const CNPJ_W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

/** Brazil CNPJ (numeric or the 2026 alphanumeric form): the two check digits of the first twelve. */
export function cnpjCheckDigits(first12: string): string {
  if (!/^[0-9A-Z]{12}$/.test(first12)) {
    throw new TypeError('mask: cnpjCheckDigits needs exactly 12 characters 0-9 A-Z');
  }
  const v = Array.from(first12, (c) => c.charCodeAt(0) - 48);
  const dv = (weights: number[], values: number[]): number => {
    const r = values.reduce((sum, x, i) => sum + x * weights[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(CNPJ_W1, v);
  const d2 = dv(CNPJ_W2, [...v, d1]);
  return `${d1}${d2}`;
}

/** Chile RUT/RUN: the check digit ('0'-'9' or 'K') of a 7- or 8-digit body. */
export function rutCheckDigit(body: string): string {
  if (!/^[0-9]{7,8}$/.test(body)) throw new TypeError('mask: rutCheckDigit needs 7 or 8 digits');
  let sum = 0;
  let weight = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const r = 11 - (sum % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}

const W_5432765432 = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];

function mod11Remainder(first10: string, what: string): number {
  const d = digitsOf(first10, 10, what);
  return d.reduce((sum, x, i) => sum + x * W_5432765432[i]!, 0) % 11;
}

/** Argentina CUIT/CUIL: the check digit of the first ten (remainder 10 maps to 9, as AFIP does). */
export function cuitCheckDigit(first10: string): string {
  const r = 11 - mod11Remainder(first10, 'cuitCheckDigit');
  return String(r === 11 ? 0 : r === 10 ? 9 : r);
}

/** Peru RUC: the check digit of the first ten. */
export function rucCheckDigit(first10: string): string {
  return String((11 - mod11Remainder(first10, 'rucCheckDigit')) % 10);
}

const CURP_ALPHABET = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ';

/** Mexico CURP: the check digit of the first seventeen characters (uppercase). */
export function curpCheckDigit(first17: string): string {
  if (!/^[0-9A-Z]{17}$/.test(first17)) {
    throw new TypeError('mask: curpCheckDigit needs exactly 17 characters 0-9 A-Z');
  }
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CURP_ALPHABET.indexOf(first17[i]!) * (18 - i);
  return String((10 - (sum % 10)) % 10);
}

/** YYMMDD with a real month and day (29 February only when YY is divisible by 4). */
function isYymmdd(s: string): boolean {
  const yy = Number(s.slice(0, 2));
  const mm = Number(s.slice(2, 4));
  const dd = Number(s.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1) return false;
  const days = [31, yy % 4 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1]!;
  return dd <= days;
}

// ── Value layer ──────────────────────────────────────────────────────────────────────────────

export interface Detector {
  readonly label: MaskLabel;
  /** Global, for scanning a string. */
  readonly scan: RegExp;
  /** Anchored, for "is this whole value one identifier". */
  readonly whole: RegExp;
  /** The canonical form of a valid candidate, or null. Same id in any punctuation = same form. */
  readonly canonical: (candidate: string) => string | null;
}

function detector(
  label: MaskLabel,
  source: string,
  flags: string,
  canonical: (candidate: string) => string | null,
): Detector {
  return {
    label,
    scan: new RegExp(source, `g${flags}`),
    whole: new RegExp(`^(?:${source})$`, flags),
    canonical,
  };
}

/** A value with everything but letters and digits dropped, uppercased: `12.345.678-k` → 12345678K. */
export const stripSeparators = (s: string): string =>
  s.replace(/[^0-9A-Za-zÑñ&]/g, '').toUpperCase();

// Hyphens and dashes as ids get written, text pulled from PDFs and word processors included:
// hyphen-minus, U+2010-U+2015 (hyphen, non-breaking hyphen, figure dash, en dash, em dash,
// horizontal bar), U+2212 minus, and the small and fullwidth hyphen-minus. A regex class fragment.
const DASH = '\\-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D';
const SEP = `[.\\s${DASH}]`; // one separator between digit groups

// Order only names an id two detectors read over the same span: an 11-digit run is a CPF before a
// CUIT or a RUC (the label is cosmetic; all three mask). The value layer (mask.ts scanText) runs
// every detector over the original string and masks the union of their valid spans, so where two
// formats overlap neither can take part of the other; wholeIdentifier takes the first that fits.
export const DETECTORS: readonly Detector[] = [
  detector(
    'CURP',
    '(?<![0-9A-Za-z])[A-Za-z]{4}[0-9]{6}[HMXhmx][A-Za-z]{5}[0-9A-Za-z][0-9](?![0-9A-Za-z])',
    '',
    (m) => {
      const c = m.toUpperCase();
      return isYymmdd(c.slice(4, 10)) && curpCheckDigit(c.slice(0, 17)) === c[17] ? c : null;
    },
  ),
  // A person's RFC. Its last character IS a check digit, but python-stdnum estimates ~1.5% of issued
  // numbers failing it and leaves the check off by default; gating on it would leak those. The
  // real YYMMDD date is the structural check (it rejects ~96% of random digit runs). Written
  // whole in either case, or grouped (`GODE 561231 GR8`, stdnum's own format; `GODE-561231-GR8`)
  // in capitals only: a lowercase word, a date-like number and a short word is prose.
  detector(
    'RFC',
    `(?<![0-9A-Za-zÑñ&])(?:[A-Za-zÑñ&]{4}[0-9]{6}[0-9A-Za-z]{3}|[A-ZÑ&]{4}[\\s${DASH}]?[0-9]{6}[\\s${DASH}]?[0-9A-Z]{3})(?![0-9A-Za-zÑñ&])`,
    '',
    (m) => {
      const c = stripSeparators(m);
      return isYymmdd(c.slice(4, 10)) ? c : null;
    },
  ),
  detector(
    'CPF',
    `(?<![0-9])[0-9]{3}${SEP}?[0-9]{3}${SEP}?[0-9]{3}\\s?[.${DASH}]?\\s?[0-9]{2}(?![0-9])`,
    '',
    (m) => {
      const d = stripSeparators(m);
      // Eleven equal digits pass the checksum but are never issued; they are placeholders.
      if (/^(\d)\1{10}$/.test(d)) return null;
      return cpfCheckDigits(d.slice(0, 9)) === d.slice(9) ? d : null;
    },
  ),
  // The DNI body may be dotted (`20-12.345.678-6`).
  detector(
    'CUIT',
    `(?<![0-9])(?:20|23|24|27)${SEP}?[0-9]{2}\\.?[0-9]{3}\\.?[0-9]{3}${SEP}?[0-9](?![0-9])`,
    '',
    (m) => {
      const d = stripSeparators(m);
      return cuitCheckDigit(d.slice(0, 10)) === d[10] ? d : null;
    },
  ),
  detector('RUC', '(?<![0-9])(?:10|15|17)[0-9]{9}(?![0-9])', '', (m) =>
    rucCheckDigit(m.slice(0, 10)) === m[10] ? m : null,
  ),
  // Only the shapes that say "RUT": dotted thousands, a hyphen before the check digit, or a K.
  // Bare 8-9 digit runs are key-only — one random number in eleven passes mod 11.
  detector(
    'RUT',
    `(?<![0-9])(?:(?:[0-9]{1,2}\\.[0-9]{3}\\.[0-9]{3}|[0-9]{7,8})\\s?[${DASH}]\\s?(?:[0-9](?![0-9])|[kK](?![0-9A-Za-z]))|[0-9]{7,8}[kK](?![0-9A-Za-z]))`,
    '',
    (m) => {
      const c = stripSeparators(m);
      const body = c.slice(0, -1);
      return rutCheckDigit(body) === c.slice(-1) ? c : null;
    },
  ),
];

/** The identifier a WHOLE value is, if it is exactly one (key layer: label and token stability). */
export function wholeIdentifier(s: string): { label: MaskLabel; canonical: string } | null {
  const t = s.trim();
  for (const det of DETECTORS) {
    if (!det.whole.test(t)) continue;
    const canonical = det.canonical(t);
    if (canonical !== null) return { label: det.label, canonical };
  }
  return null;
}

// ── Key layer ────────────────────────────────────────────────────────────────────────────────

/**
 * A key rule that masks: always, or unless the value is a company id ('mixed'). `anyValue` marks a
 * field whose values need not be written in digits (an identityKeys field the lists do not name: a
 * birthplace, a marital status), so no value of it is taken for a placeholder.
 */
export type MaskRule =
  | { readonly kind: 'mask'; readonly label: MaskLabel; readonly anyValue?: true }
  | { readonly kind: 'mixed'; readonly label: MaskLabel; readonly company: (v: string) => boolean };
export type KeyRule = { readonly kind: 'raw' } | MaskRule;

const RAW: KeyRule = { kind: 'raw' };
const IDENTITY_FIELD: MaskRule = { kind: 'mask', label: 'ID', anyValue: true };

// A key's words: accents dropped, camelCase / snake_case / kebab split, lowercased, and a 1-2 digit
// ordinal dropped (`cpf2`, `addressLine1`), but not a longer number (`rfc3339` stays itself). An
// acronym's plural stays one word (`CPFs`, `DNIsSocio`), not `CP Fs`.
function keyWords(key: string, keepOrdinals = false): string[] {
  const words = key
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    // `CPFSocio` → CPF Socio; `IPv4` and `CPFs` stay.
    .replace(/([A-Z])([A-Z](?!s(?![a-z]))[a-z])(?![0-9])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
  return keepOrdinals ? words : words.map((w) => w.replace(/(?<=[a-z])[0-9]{1,2}$/, ''));
}

/**
 * A field name as a ruling names it: case-, accent- and separator-insensitive, ordinals KEPT, so
 * `birth_date` names `birthDate` and `cpf2` names `cpf_2`, never `cpf` or `cpf1`.
 */
export const exactKey = (key: string): string => keyWords(key, true).join('');

const ID_SEPARATORS = new RegExp(`[\\s./${DASH}]`, 'g');
const compactId = (v: string): string => v.toUpperCase().replace(ID_SEPARATORS, '');

const isCnpj = (v: string): boolean => {
  const c = compactId(v);
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(c) && cnpjCheckDigits(c.slice(0, 12)) === c.slice(12);
};
const isCompanyCuit = (v: string): boolean => {
  const d = compactId(v);
  return /^3[034][0-9]{9}$/.test(d) && cuitCheckDigit(d.slice(0, 10)) === d[10];
};
const isCompanyRuc = (v: string): boolean => {
  const d = compactId(v);
  return /^20[0-9]{9}$/.test(d) && rucCheckDigit(d.slice(0, 10)) === d[10];
};
const isCompanyRfc = (v: string): boolean => {
  const c = compactId(v);
  return /^[A-ZÑ&]{3}[0-9]{6}[0-9A-Z]{3}$/.test(c) && isYymmdd(c.slice(3, 9));
};
const isCompanyId = (v: string): boolean =>
  isCnpj(v) || isCompanyCuit(v) || isCompanyRuc(v) || isCompanyRfc(v);

// Person ids whose name occurs in no everyday en/pt/es word, matched ANYWHERE in the key, so
// one-case compounds (`numerocpf`, `CPFSOCIO`, `passportnumber`) and plurals (`cpfs`) match too.
const DISTINCTIVE_ID_STEMS: ReadonlyArray<readonly [string, MaskLabel]> = [
  ['cpf', 'CPF'],
  ['curp', 'CURP'],
  ['cuil', 'CUIL'],
  ['passport', 'PASSPORT'],
  ['pasaporte', 'PASSPORT'],
  ['passaporte', 'PASSPORT'],
  ['cedula', 'ID'],
];

// Short ids that everyday words DO contain (`truth`, `circuit`, `midnight`, `classname`, `rgb`,
// `structure`): a whole key word, or one joined only to a number word before it (`nrodni`,
// `numeroderut`) or a closed set of words after it (`rutsocio`, `ssnlast4`), plurals included.
// `run` (Chile's RUN) is left out: it is an everyday English key (`run`, `runId`), and Chilean
// data writes the number as RUT. (Maps, not object literals: a key word like `constructor` must
// not find Object.prototype.)
const SHORT_PERSON_IDS: ReadonlyMap<string, MaskLabel> = new Map([
  ['rut', 'RUT'],
  ['dni', 'DNI'],
  ['ssn', 'SSN'],
  ['rg', 'ID'],
]);
// Keys that hold a person's OR a company's number: masked unless the value is a valid company id.
const SHORT_MIXED_IDS: ReadonlyMap<string, MaskRule> = new Map([
  ['cuit', { kind: 'mixed', label: 'CUIT', company: isCompanyCuit }],
  ['rfc', { kind: 'mixed', label: 'RFC', company: isCompanyRfc }],
  ['ruc', { kind: 'mixed', label: 'RUC', company: isCompanyRuc }],
]);
const ID_PREFIX = '(?:numero(?:de)?|nro|num|nr|no|n)';
const ID_SUFFIX = `(?:${[
  'socio',
  'cliente',
  'titular',
  'empresa',
  'representante',
  'responsavel',
  'responsable',
  'conyuge',
  'conjuge',
  'pessoa',
  'persona',
  'principal',
  'holder',
  'owner',
  'number',
  'numero',
  'nro',
  'num',
  'no',
  'last',
  'dv',
  'digito',
].join('|')})`;
const SHORT_ID_WORD = new RegExp(
  `^${ID_PREFIX}?(${[...SHORT_PERSON_IDS.keys(), ...SHORT_MIXED_IDS.keys()].join('|')})(?:e?s)?(?:${ID_SUFFIX}(?:e?s)?)?$`,
);
const shortId = (word: string): string | undefined => SHORT_ID_WORD.exec(word)?.[1];

const CPF_OR_CNPJ: MaskRule = { kind: 'mixed', label: 'CPF', company: isCnpj };
// Identity-document numbers. In Brazil and Argentina the "document" is often a CPF OR a CNPJ /
// CUIT, so these keep a valid company id of any kind and mask everything else. A value that is
// ALSO a valid person id (a RUC 20 that is a person CUIT, about 9 in 11; a CPF that is a company
// CUIT 30/33/34) is masked: the key cannot say which it is, so it fails closed, as the value layer
// does. Only a `ruc` key reads such a number as the company RUC it is named for.
const DOCUMENT_NUMBER: MaskRule = {
  kind: 'mixed',
  label: 'ID',
  company: (v) => isCompanyId(v) && wholeIdentifier(v) === null,
};
const DOCUMENT_NUMBER_SUFFIX = new RegExp(
  `(?:${[
    'numerodocumento',
    'numerodedocumento',
    'nrodocumento',
    'numdocumento',
    'numerodoc',
    'nrodoc',
    'numdoc',
    'documentnumber',
    'documentno',
    'docnumber',
    'docno',
  ].join('|')})(?:e?s)?$`,
);

// Generic identity-document keys, matched as the END of the normalized key (a plural too).
const GENERIC_ID_SUFFIXES = [
  'identificationnumber',
  'identificationno',
  'nationalid',
  'nationalidnumber',
  'nationalidentifier',
  'nationalidentificationnumber',
  'nationalidentitynumber',
  'personalid',
  'personalidnumber',
  'personalidentificationnumber',
  'governmentid',
  'governmentidnumber',
  'idnumber',
  'idcardnumber',
  'identitynumber',
  'identitycardnumber',
  'socialsecuritynumber',
  'numeroidentificacion',
  'numerodeidentificacion',
  'documentoidentidad',
  'documentodeidentidad',
  'documentonacionaldeidentidad',
  'registrogeral',
  'carteiraidentidade',
  'carteiradeidentidade',
  'carnedeextranjeria',
  'carneextranjeria',
  'claveelector',
  'teudatzehut',
];
const GENERIC_ID = new RegExp(`(?:${GENERIC_ID_SUFFIXES.join('|')})(?:e?s)?$`);

// Identity attributes, matched as a SUBSTRING of the normalized key. Birthplace before birth date.
const ATTRIBUTE_STEMS: ReadonlyArray<readonly [MaskLabel, readonly string[]]> = [
  [
    'BIRTHPLACE',
    [
      'birthplace',
      'placeofbirth',
      'countryofbirth',
      'cityofbirth',
      'birthcountry',
      'birthcity',
      'lugardenacimiento',
      'lugarnacimiento',
      'paisdenacimiento',
      'paisnacimiento',
      'localdenascimento',
      'localnascimento',
      'naturalidade',
    ],
  ],
  [
    'DOB',
    [
      'birthdate',
      'birthdt',
      'dateofbirth',
      'birthday',
      'birthyear',
      'yearofbirth',
      'nacimiento', // fechaNacimiento, fecnacimiento
      'nascimento', // dataNascimento, dtnascimento
      'fechadenac',
      'fechanac',
      'fecnac',
      'datanasc',
      'dtnasc',
    ],
  ],
  [
    'NATIONALITY',
    ['nationality', 'nationalities', 'citizenship', 'nacionalidad', 'cidadania', 'ciudadania'],
  ],
  [
    'PARENT',
    [
      'mothername',
      'mothersname',
      'maidenname',
      'fathername',
      'fathersname',
      'nomemae',
      'nomedamae',
      'nomepai',
      'nomedopai',
      'nombremadre',
      'nombredelamadre',
      'nombrepadre',
      'nombredelpadre',
      'filiacao',
    ],
  ],
];
// Birth-date words standing alone in a key (`dob`, `dobs`).
const DOB_WORDS = new Set(['dob', 'dobs']);

// Postal address. A word holding a stem (`address`, `addressLine`, `homeaddress`,
// `enderecoResidencial`, `domicilioFiscal`) — unless what stands right before the stem, in the same
// word or as the previous word, says it is not postal (`emailAddress`, `ipaddress`, `mac_addr`).
// Plus street and postal-code keys.
const ADDRESS_STEMS = ['address', 'addr', 'endereco', 'direccion', 'domicilio', 'logradouro'];
const NOT_POSTAL = new Set([
  'email',
  'ip',
  'ipv', // `ipv4` / `ipv6` after keyWords drops the trailing digit
  'mac',
  'web',
  'website',
  'url',
  'wallet',
  'server',
  'host',
  'proxy',
  'remote',
  'network',
  'contract',
  'memory',
]);
const ADDRESS_WORDS = new Set(['street', 'calle', 'rua', 'cep', 'zip', 'zipcode', 'postcode']);
const ADDRESS_SUBSTRINGS = ['postalcode', 'zipcode', 'postcode', 'codigopostal', 'codpostal'];

function isAddressKey(words: readonly string[], normalized: string): boolean {
  if (words.some((w) => ADDRESS_WORDS.has(w))) return true;
  if (ADDRESS_SUBSTRINGS.some((s) => normalized.includes(s))) return true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    for (const stem of ADDRESS_STEMS) {
      const at = w.indexOf(stem);
      if (at < 0) continue;
      const qualifier = at === 0 ? (words[i - 1] ?? '') : w.slice(0, at);
      if (!NOT_POSTAL.has(qualifier)) return true;
    }
  }
  return false;
}

/**
 * How a value under this key is treated: RAW (an allowRaw field), masked, masked unless it is a
 * company id ('mixed'), or null (not an identity key: the value layer only). An identityKeys field
 * is always masked: under its built-in label and that label's placeholder rule if it has one (a
 * person-or-company key losing its company exemption), otherwise as ID whatever the value.
 */
export function classifyKey(
  key: string,
  allowRaw: ReadonlySet<string>,
  identityKeys: ReadonlySet<string>,
): KeyRule | null {
  const words = keyWords(key);
  const n = words.join('');
  if (n === '') return null;
  const exact = allowRaw.size + identityKeys.size > 0 ? exactKey(key) : '';
  if (allowRaw.has(exact)) return RAW;
  const rule = builtInRule(words, n);
  if (!identityKeys.has(exact)) return rule;
  if (rule === null) return IDENTITY_FIELD;
  return rule.kind === 'mask' ? rule : { kind: 'mask', label: rule.label };
}

function builtInRule(words: readonly string[], n: string): MaskRule | null {
  if (n.includes('cpf') && n.includes('cnpj')) return CPF_OR_CNPJ;
  for (const [stem, label] of DISTINCTIVE_ID_STEMS) {
    if (n.includes(stem)) return { kind: 'mask', label };
  }
  const shortIds = words.map(shortId);
  for (const id of shortIds) {
    const label = id === undefined ? undefined : SHORT_PERSON_IDS.get(id);
    if (label) return { kind: 'mask', label };
  }
  for (const id of shortIds) {
    const rule = id === undefined ? undefined : SHORT_MIXED_IDS.get(id);
    if (rule) return rule;
  }
  if (DOCUMENT_NUMBER_SUFFIX.test(n)) return DOCUMENT_NUMBER;
  if (GENERIC_ID.test(n)) return { kind: 'mask', label: 'ID' };
  for (const [label, stems] of ATTRIBUTE_STEMS) {
    if (stems.some((s) => n.includes(s))) return { kind: 'mask', label };
  }
  if (words.some((w) => DOB_WORDS.has(w))) return { kind: 'mask', label: 'DOB' };
  if (isAddressKey(words, n)) return { kind: 'mask', label: 'ADDRESS' };
  return null;
}
