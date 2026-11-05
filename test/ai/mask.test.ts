// Tool-result masking (PIA C3), src/ai/mask.ts.
//
// Every identifier here is SYNTHETIC: sequential or generated digits, completed at runtime with the
// module's own check-digit functions — which are themselves pinned, first, against values computed
// by an independent reference (python-stdnum's formulas; the Receita Federal's for the CNPJ), so a
// wrong check digit cannot hide behind fixtures generated with it.
import { describe, expect, it } from 'vitest';
import {
  cnpjCheckDigits,
  cpfCheckDigits,
  cuitCheckDigit,
  curpCheckDigit,
  type JsonValue,
  MASK_LABELS,
  MASK_LIMITS,
  MASK_TOKEN_PATTERN,
  MaskTurn,
  maskToolResult,
  OMITTED,
  rucCheckDigit,
  rutCheckDigit,
  TRUNCATED,
} from '../../src/ai/mask';

// ── Synthetic fixtures ─────────────────────────────────────────────────────────────────────────

const cpf = (first9: string): string => first9 + cpfCheckDigits(first9);
const dotCpf = (d: string): string =>
  `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
const rut = (body: string): string => body + rutCheckDigit(body);
const dotRut = (id: string): string =>
  `${id.slice(0, -1).replace(/\B(?=(\d{3})+$)/g, '.')}-${id.slice(-1)}`;
const cuit = (first10: string): string => first10 + cuitCheckDigit(first10);
const dashCuit = (d: string): string => `${d.slice(0, 2)}-${d.slice(2, 10)}-${d.slice(10)}`;
const ruc = (first10: string): string => first10 + rucCheckDigit(first10);
const curp = (first17: string): string => first17 + curpCheckDigit(first17);
const cnpj = (first12: string): string => first12 + cnpjCheckDigits(first12);
/** The same string with its last character replaced by a different digit: a failed check. */
const breakLast = (id: string): string => {
  const last = id.slice(-1);
  const next = /[0-9]/.test(last) ? String((Number(last) + 1) % 10) : '0';
  return id.slice(0, -1) + next;
};

const CPF_A = cpf('123456789'); // 12345678909
const CPF_B = cpf('111444777'); // 11144477735
const RUT_A = rut('12345678'); // 123456785
const RUT_K = rut('10000013'); // 10000013K
const CUIT_PERSON = cuit('2012345678'); // 20123456786 — also a valid Peruvian company RUC
const CUIT_COMPANY = cuit('3071234567'); // 30712345671
const RUC_PERSON = ruc('1012345678'); // 10123456781
const RUC_COMPANY = ruc('2010000005'); // 20100000050 — NOT a valid CUIT (that would end in 9)
const CURP_A = curp('ABCD990101HDFXYZ0'); // ABCD990101HDFXYZ08
const RFC_PERSON = 'ABCD990101AB1'; // 4 letters, a real date, homoclave
const RFC_COMPANY = 'ABC990101AB1'; // 3 letters: a legal entity
const CNPJ_A = cnpj('112223330001'); // 11222333000181

function mask(value: unknown, opts?: Parameters<typeof maskToolResult>[1]): JsonValue {
  return maskToolResult(value, opts).value;
}

const TOKEN_RE = new RegExp(MASK_TOKEN_PATTERN, 'g');
const tokensIn = (value: JsonValue): string[] => JSON.stringify(value).match(TOKEN_RE) ?? [];

// Deterministic PRNG (mulberry32): the property tests are reproducible from their seed.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// ── Check digits ───────────────────────────────────────────────────────────────────────────────

describe('check digits — pinned to an independent reference', () => {
  it('CPF', () => {
    expect(cpfCheckDigits('123456789')).toBe('09');
    expect(cpfCheckDigits('111444777')).toBe('35');
    expect(cpfCheckDigits('987654321')).toBe('00');
  });

  it('CNPJ, numeric and the alphanumeric form', () => {
    expect(cnpjCheckDigits('112223330001')).toBe('81');
    expect(cnpjCheckDigits('123456780001')).toBe('95');
    expect(cnpjCheckDigits('12ABC34501DE')).toBe('35');
    expect(cnpjCheckDigits('000000020001')).toBe('80'); // a remainder below 2 gives 0
  });

  it('RUT, including the K check digit', () => {
    expect(rutCheckDigit('12345678')).toBe('5');
    expect(rutCheckDigit('7654321')).toBe('6');
    expect(rutCheckDigit('10000013')).toBe('K');
    expect(rutCheckDigit('23456781')).toBe('0');
  });

  it('CUIT, with remainder 10 mapped to 9', () => {
    expect(cuitCheckDigit('2012345678')).toBe('6');
    expect(cuitCheckDigit('2711111111')).toBe('7');
    expect(cuitCheckDigit('3071234567')).toBe('1');
    expect(cuitCheckDigit('2010000005')).toBe('9');
  });

  it('RUC', () => {
    expect(rucCheckDigit('1012345678')).toBe('1');
    expect(rucCheckDigit('2012345678')).toBe('6');
    expect(rucCheckDigit('2010000005')).toBe('0');
  });

  it('CURP', () => {
    expect(curpCheckDigit('ABCD990101HDFXYZ0')).toBe('8');
    expect(curpCheckDigit('WXYZ010203MNLQRS0')).toBe('9');
    expect(curpCheckDigit('ABCD990101XDFXYZ0')).toBe('2');
  });

  it('refuses malformed input instead of guessing', () => {
    expect(() => cpfCheckDigits('12345678')).toThrow(TypeError);
    expect(() => cpfCheckDigits('12345678a')).toThrow(TypeError);
    expect(() => cnpjCheckDigits('1122233300')).toThrow(TypeError);
    expect(() => rutCheckDigit('123456')).toThrow(TypeError);
    expect(() => cuitCheckDigit('201234567')).toThrow(TypeError);
    expect(() => rucCheckDigit('10123456789')).toThrow(TypeError);
    expect(() => curpCheckDigit('abcd990101hdfxyz0')).toThrow(TypeError);
  });
});

// ── Value layer ────────────────────────────────────────────────────────────────────────────────

describe('value layer — checksum-valid identifiers in any string', () => {
  it('masks a CPF in every common punctuation, as one token, keeping the text around it', () => {
    const text = [
      `a ${dotCpf(CPF_A)} b`,
      CPF_A,
      '123456789-09',
      '123 456 789 09',
      '123.456.78909',
    ].join(' | ');
    expect(mask(text)).toBe('a [CPF#1] b | [CPF#1] | [CPF#1] | [CPF#1] | [CPF#1]');
  });

  it('leaves an invalid CPF, a repeated-digit placeholder and a longer digit run alone', () => {
    expect(mask(dotCpf(breakLast(CPF_A)))).toBe('123.456.789-00');
    expect(mask('111.111.111-11')).toBe('111.111.111-11');
    expect(mask(`${CPF_A}1`)).toBe(`${CPF_A}1`);
    expect(mask(`9${CPF_A}`)).toBe(`9${CPF_A}`);
  });

  it('masks CPFs packed into a list with no spaces (no decimal-point guard that could leak)', () => {
    expect(mask(`${dotCpf(CPF_A)},${dotCpf(CPF_B)};${CPF_A}.`)).toBe('[CPF#1],[CPF#2];[CPF#1].');
    expect(mask(`cpf:${CPF_A}x`)).toBe('cpf:[CPF#1]x');
  });

  it("masks a person's CUIT/CUIL, not a company's", () => {
    expect(mask(`CUIT ${dashCuit(CUIT_PERSON)}`)).toBe('CUIT [CUIT#1]');
    expect(mask(CUIT_PERSON)).toBe('[CUIT#1]');
    expect(mask(dashCuit(cuit('2010000005')))).toBe('[CUIT#1]'); // remainder-10 → 9
    expect(mask(dashCuit(CUIT_COMPANY))).toBe('30-71234567-1');
    expect(mask(CUIT_COMPANY)).toBe(CUIT_COMPANY);
    expect(mask('20-12345678-4')).toBe('20-12345678-4'); // bad check digit (and not a RUT either)
  });

  it("masks a person's RUC (10 carries the DNI); a company RUC stays unless it is also a person CUIT", () => {
    expect(mask(`RUC ${RUC_PERSON}`)).toBe('RUC [RUC#1]');
    expect(mask(RUC_COMPANY)).toBe(RUC_COMPANY);
    expect(mask(breakLast(RUC_PERSON))).toBe(breakLast(RUC_PERSON));
    // Fails closed where the format cannot tell: a 20… number valid as a person CUIT is masked
    // even though it is also a valid Peruvian company RUC.
    expect(rucCheckDigit(CUIT_PERSON.slice(0, 10))).toBe(CUIT_PERSON.slice(10));
    expect(mask(CUIT_PERSON)).toBe('[CUIT#1]');
  });

  it('masks a RUT when its shape says RUT — dots, a hyphen or a K — as one token', () => {
    const dotted = dotRut(RUT_A); // 12.345.678-5
    expect(dotted).toBe('12.345.678-5');
    expect(mask(`${dotted} / 12345678-5 / 12345678 - 5`)).toBe('[RUT#1] / [RUT#1] / [RUT#1]');
    expect(mask(`${dotRut(RUT_K)} 10000013-k ${RUT_K} 10000013k`)).toBe(
      '[RUT#1] [RUT#1] [RUT#1] [RUT#1]',
    );
    expect(mask(dotRut(rut('7654321')))).toBe('[RUT#1]'); // a 7-digit body
  });

  it('leaves a bare-digit RUT, an invalid RUT and a K glued to a word alone', () => {
    expect(mask(RUT_A)).toBe('123456785'); // key-only: 1 in 11 random numbers passes mod 11
    expect(mask('12.345.678-4')).toBe('12.345.678-4');
    expect(mask('10000013-Kg')).toBe('10000013-Kg');
  });

  it('masks a CURP in either case, and only with a real date and check digit', () => {
    expect(mask(`curp ${CURP_A}.`)).toBe('curp [CURP#1].');
    expect(mask(CURP_A.toLowerCase())).toBe('[CURP#1]');
    expect(mask(breakLast(CURP_A))).toBe(breakLast(CURP_A));
    const badDate = curp('ABCD991301HDFXYZ0'); // month 13
    expect(mask(badDate)).toBe(badDate);
    expect(mask(curp('ABCD990101XDFXYZ0'))).toBe('[CURP#1]'); // sex X
  });

  it("masks a person's RFC by structure; a company RFC and a bad date stay", () => {
    expect(mask(`RFC ${RFC_PERSON}`)).toBe('RFC [RFC#1]');
    expect(mask(RFC_PERSON.toLowerCase())).toBe('[RFC#1]');
    expect(mask('ÑAND000229XY9')).toBe('[RFC#1]'); // Ñ, and 29 Feb in a year divisible by 4
    expect(mask('ABCD010229XY9')).toBe('ABCD010229XY9'); // 29 Feb 01
    expect(mask('ABCD991341AB1')).toBe('ABCD991341AB1');
    expect(mask(RFC_COMPANY)).toBe(RFC_COMPANY);
    expect(mask(`X${RFC_PERSON}`)).toBe(`X${RFC_PERSON}`); // part of a longer code
  });

  // U+2013 en dash and U+2011 non-breaking hyphen: what text pulled from a PDF or Word file holds.
  const EN = '\u2013';
  const NB = '\u2011';

  it('masks the grouped and dashed forms ids are printed in, as one token per id', () => {
    const turn = new MaskTurn();
    const cpfForms = [
      '123.456.789 - 09',
      '123-456-789-09',
      `123.456.789${EN}09`,
      `123${NB}456${NB}789${NB}09`,
      '123 456 789 - 09',
    ];
    expect(mask(cpfForms.join(' | '), { turn })).toBe(cpfForms.map(() => '[CPF#1]').join(' | '));
    // python-stdnum's mx.rfc.format() spaces a person's RFC; hyphens are common too.
    const rfcForms = [
      'ABCD 990101 AB1',
      'ABCD-990101-AB1',
      'ABCD990101-AB1',
      `ABCD${EN}990101${EN}AB1`,
    ];
    expect(mask(`x ${rfcForms.join(' / ')} y`, { turn })).toBe(
      `x ${rfcForms.map(() => '[RFC#1]').join(' / ')} y`,
    );
    const cuitForms = ['20-12.345.678-6', `20${EN}12345678${EN}6`, '20 12.345.678 6'];
    expect(mask(cuitForms.join('; '), { turn })).toBe(cuitForms.map(() => '[CUIT#1]').join('; '));
    expect(mask(`RUT 12.345.678${EN}5, 12345678 ${EN} 5`, { turn })).toBe('RUT [RUT#1], [RUT#1]');
  });

  it('reads a separated RFC only in capitals, so prose with a date-like number is left alone', () => {
    for (const s of ['abcd 990101 ab1', 'Nota 230115 foi', 'CASO 230115 foi']) {
      expect(mask(s)).toBe(s);
    }
  });

  // Review: every detector reads the ORIGINAL string. When they ran one after another on the text
  // the one before had already masked, a grouped RFC (a capitals word, a YYMMDD date) took the
  // first group of a dotted CPF after it, and 8 of the CPF's 11 digits went out raw.
  it('masks every id where two formats overlap, so neither can hide part of the other', () => {
    for (const form of [dotCpf(CPF_A), '123 456 789 09', '123-456-789-09', `123.456.789${EN}09`]) {
      const { value, turn } = maskToolResult(`NASC 850312 ${form}`);
      expect(value).toBe('[RFC#1][CPF#1]');
      expect(turn.tokens().get('[RFC#1]')).toBe(`NASC 850312 ${form.slice(0, 3)}`);
      expect(turn.tokens().get('[CPF#1]')).toBe(form);
    }
    // The other way round: a CPF whose first nine digits are an RFC's date and homoclave.
    const tail = cpfCheckDigits('561231123');
    expect(mask(`GODE 561231 123-${tail} x`)).toBe('[RFC#1][CPF#1] x');
    // The same span read by two detectors is one id, named by the earlier detector (as a key-layer
    // value is): here a CPF that is also a valid person CUIT, found at runtime.
    let cpfAlsoCuit = '';
    for (let n = 201_000_000; cpfAlsoCuit === ''; n++) {
      const id = cpf(String(n));
      if (cuitCheckDigit(id.slice(0, 10)) === id[10]) cpfAlsoCuit = id;
    }
    const { value, turn } = maskToolResult({
      a: `x ${cpfAlsoCuit} y ${cpfAlsoCuit}`,
      cpf: cpfAlsoCuit,
    });
    expect(value).toEqual({ a: 'x [CPF#1] y [CPF#1]', cpf: '[CPF#1]' });
    expect(turn.counters()).toEqual({ CPF: 1 });
  });

  it('never masks by value what has no check digit: DNI, bare 8-9 digit runs, CNPJ', () => {
    for (const s of ['12345678', '12.345.678', '123456789', dotCpf(CPF_A).slice(0, 11), CNPJ_A]) {
      expect(mask(s)).toBe(s);
    }
    expect(mask('11.222.333/0001-81')).toBe('11.222.333/0001-81');
  });

  it('masks an 11-digit integer that is a valid id, and no other number', () => {
    expect(mask(Number(CPF_A))).toBe('[CPF#1]');
    expect(mask(Number(CUIT_PERSON))).toBe('[CUIT#1]');
    expect(mask(Number(RUC_PERSON))).toBe('[RUC#1]');
    for (const n of [
      Number(breakLast(CPF_A)),
      1_727_222_400, // a Unix timestamp: 10 digits
      Number(CUIT_COMPANY),
      -Number(CPF_A),
      Number(CPF_A) + 0.5,
      Number(RUT_A),
    ]) {
      expect(mask(n)).toBe(n);
    }
  });

  it('scans object keys too', () => {
    expect(mask({ [dotCpf(CPF_A)]: { score: 3 } })).toEqual({ '[CPF#1]': { score: 3 } });
  });

  it('survives pathological strings in one linear pass', () => {
    const run = '9'.repeat(300_000);
    expect(mask(run)).toBe(run);
    const many = Array.from({ length: 5_000 }, () => dotCpf(CPF_A)).join(' ');
    expect(mask(many)).toBe(Array.from({ length: 5_000 }, () => '[CPF#1]').join(' '));
  });
});

// ── Key layer ──────────────────────────────────────────────────────────────────────────────────

describe('key layer — identity keys are masked whatever the value', () => {
  const only = (key: string, value: unknown = 'x-1') =>
    (mask({ [key]: value }) as Record<string, JsonValue>)[key];

  it.each([
    ['cpf', 'CPF'],
    ['CPF', 'CPF'],
    ['numeroCpf', 'CPF'],
    ['cpf_socio', 'CPF'],
    ['CPFSocio', 'CPF'],
    ['cpf2', 'CPF'],
    ['rut', 'RUT'],
    ['rutEmpresa', 'RUT'],
    ['curp', 'CURP'],
    ['cuil', 'CUIL'],
    ['dni', 'DNI'],
    ['numero_dni', 'DNI'],
    ['ssn', 'SSN'],
    ['passportNumber', 'PASSPORT'],
    ['pasaporte', 'PASSPORT'],
    ['passaporte', 'PASSPORT'],
    ['cedula', 'ID'],
    ['cédula', 'ID'],
    ['rg', 'ID'],
    ['identificationNumber', 'ID'],
    ['nationalId', 'ID'],
    ['national_id_number', 'ID'],
    ['idNumber', 'ID'],
    ['numeroDocumento', 'ID'],
    ['documento_de_identidad', 'ID'],
    ['carneExtranjeria', 'ID'],
    ['teudatZehut', 'ID'],
    ['birthDate', 'DOB'],
    ['date_of_birth', 'DOB'],
    ['DOB', 'DOB'],
    ['birthday', 'DOB'],
    ['birthYear', 'DOB'],
    ['fechaNacimiento', 'DOB'],
    ['fecha_de_nacimiento', 'DOB'],
    ['dataNascimento', 'DOB'],
    ['data_de_nascimento', 'DOB'],
    ['nascimento', 'DOB'],
    ['placeOfBirth', 'BIRTHPLACE'],
    ['lugarDeNacimiento', 'BIRTHPLACE'],
    ['naturalidade', 'BIRTHPLACE'],
    ['localNascimento', 'BIRTHPLACE'],
    ['nationality', 'NATIONALITY'],
    ['nacionalidade', 'NATIONALITY'],
    ['nacionalidad', 'NATIONALITY'],
    ['citizenship', 'NATIONALITY'],
    ['nomeMae', 'PARENT'],
    ['nome_da_mae', 'PARENT'],
    ['mothersName', 'PARENT'],
    ['nombreDeLaMadre', 'PARENT'],
    ['address', 'ADDRESS'],
    ['primaryAddress', 'ADDRESS'],
    ['homeaddress', 'ADDRESS'],
    ['addresses', 'ADDRESS'],
    ['addressLine1', 'ADDRESS'],
    ['mailingAddress', 'ADDRESS'],
    ['endereco', 'ADDRESS'],
    ['endereço', 'ADDRESS'],
    ['enderecoResidencial', 'ADDRESS'],
    ['direccion', 'ADDRESS'],
    ['dirección', 'ADDRESS'],
    ['domicilioFiscal', 'ADDRESS'],
    ['logradouro', 'ADDRESS'],
    ['street', 'ADDRESS'],
    ['streetName', 'ADDRESS'],
    ['calle', 'ADDRESS'],
    ['zip', 'ADDRESS'],
    ['zipCode', 'ADDRESS'],
    ['postal_code', 'ADDRESS'],
    ['postcode', 'ADDRESS'],
    ['cep', 'ADDRESS'],
    ['codigoPostal', 'ADDRESS'],
    // One-case compounds: no case or separator says where the id word starts.
    ['numerocpf', 'CPF'],
    ['NUMEROCPF', 'CPF'],
    ['CPFSOCIO', 'CPF'],
    ['cpfresponsavel', 'CPF'],
    ['nrodni', 'DNI'],
    ['NRODNI', 'DNI'],
    ['numdni', 'DNI'],
    ['dninumber', 'DNI'],
    ['rutcliente', 'RUT'],
    ['RUTSOCIO', 'RUT'],
    ['numeroderut', 'RUT'],
    ['ssnlast4', 'SSN'],
    ['passportnumber', 'PASSPORT'],
    ['PASSPORTNUMBER', 'PASSPORT'],
    ['CURPSOCIO', 'CURP'],
    ['cuilsocio', 'CUIL'],
    ['nrorg', 'ID'],
    // Plurals, acronym plurals included: an array of ids sits under a plural key.
    ['cpfs', 'CPF'],
    ['CPFs', 'CPF'],
    ['CPFsSocios', 'CPF'],
    ['dnis', 'DNI'],
    ['DNIs', 'DNI'],
    ['ruts', 'RUT'],
    ['RUTs', 'RUT'],
    ['rutsSocios', 'RUT'],
    ['SSNs', 'SSN'],
    ['RGs', 'ID'],
    ['passports', 'PASSPORT'],
    ['pasaportes', 'PASSPORT'],
    ['cedulas', 'ID'],
    ['CUILs', 'CUIL'],
    ['identificationNumbers', 'ID'],
    ['idNumbers', 'ID'],
    ['nationalIds', 'ID'],
    ['dobs', 'DOB'],
    ['birthDates', 'DOB'],
    // Birth-date abbreviations.
    ['birthDt', 'DOB'],
    ['birth_dt', 'DOB'],
    ['BIRTH_DT', 'DOB'],
    ['fechaDeNac', 'DOB'],
    ['fecNac', 'DOB'],
    ['fec_nac', 'DOB'],
    ['fecnacimiento', 'DOB'],
    ['dtnascimento', 'DOB'],
    // Person-or-company keys, with a value that is no company id.
    ['cuits', 'CUIT'],
    ['CUITs', 'CUIT'],
    ['nrocuit', 'CUIT'],
    ['cuitempresa', 'CUIT'],
    ['rfcs', 'RFC'],
    ['numeroruc', 'RUC'],
    ['cpfcnpj', 'CPF'],
    ['CPFCNPJ', 'CPF'],
    ['nroDoc', 'ID'],
    ['numeroDoc', 'ID'],
    ['documentNumber', 'ID'],
    ['docNumber', 'ID'],
    ['numeroDocumento', 'ID'],
  ])('%s → [%s#1]', (key, label) => {
    expect(only(key)).toBe(`[${label}#1]`);
  });

  it.each([
    'name',
    'fullName',
    'email',
    'emailAddress',
    'email_addresses',
    'ipAddress',
    'IPv4Address',
    'ip_addr',
    'mac_address',
    'webAddress',
    'city',
    'state',
    'country',
    'neighborhood',
    'companyName',
    'id',
    'personId',
    'run',
    'runId',
    'constructor',
    'toString',
    '__proto__x',
    'cnpj',
    'registrationNumber',
    'taxId',
    'rfc3339',
    'createdAt',
    '',
    '***',
    // Everyday words that CONTAIN a short id (rut, cuit, dni, ssn, rg, ruc): whole words only.
    'truth',
    'truthy',
    'circuit',
    'circuitId',
    'biscuit',
    'midnight',
    'className',
    'classname',
    'businessname',
    'rgb',
    'rgbaColor',
    'org',
    'structure',
    'truck',
    'ruta',
    'rutina',
    'route',
    'rendered',
    'dnsName',
    'proxyAddress',
    // Company tax ids in the forks (insights `taxId`, `tax_ids`, `company_tax_ids`): company data.
    'taxIds',
    'tax_ids',
    'company_tax_ids',
  ])('%s is not an identity key', (key) => {
    expect(only(key, 'plain')).toBe('plain');
  });

  it('masks any value but null, a boolean, the empty string or a placeholder (below)', () => {
    expect(only('cpf', 12345)).toBe('[CPF#1]');
    expect(only('cpf', { a: 1 })).toBe('[CPF#1]');
    expect(only('address', { street: 'Rua Um', city: 'Recife' })).toBe('[ADDRESS#1]');
    expect(only('cpf', null)).toBeNull();
    expect(only('cpf', true)).toBe(true);
    expect(only('cpf', '')).toBe('');
    expect(mask({ cpf: undefined })).toEqual({});
  });

  // One shared token for `N/A` would tell the model that every record holding it is one person.
  it('passes a placeholder under an id or birth-date key: no digit, or one digit repeated', () => {
    const principals = [
      { name: 'A', cpf: 'N/A', birthDate: 'não informado' },
      { name: 'B', cpf: 'N/A', birthDate: 'não informado' },
      { name: 'C', cpf: '000.000.000-00', dni: '-', passport: 'sem passaporte' },
      { name: 'D', cpf: '00000000000', rut: 0, cuit: 'n/a', fechaNacimiento: '0000-00-00' },
    ];
    const out = maskToolResult({ principals });
    expect(out.value).toEqual({ principals });
    expect(out.masked).toBe(0);
  });

  it('still masks a text attribute whatever it says, and a digit placeholder only whole', () => {
    expect(mask({ nationality: 'N/A', address: '-', nomeMae: 'n/a' })).toEqual({
      nationality: '[NATIONALITY#1]',
      address: '[ADDRESS#1]',
      nomeMae: '[PARENT#1]',
    });
    expect(mask({ cpf: '000.000.000-01', dni: 'A0000000' })).toEqual({
      cpf: '[CPF#1]',
      dni: '[DNI#1]',
    });
  });

  it('gives one id one token whatever its form: number or string, bare or punctuated', () => {
    const turn = new MaskTurn();
    expect(mask({ rut: RUT_A }, { turn })).toEqual({ rut: '[RUT#1]' }); // bare: key-only
    expect(mask(`titular ${dotRut(RUT_A)}`, { turn })).toBe('titular [RUT#1]');
    expect(mask({ rut: Number(RUT_A), run: dotRut(RUT_A) }, { turn })).toEqual({
      rut: '[RUT#1]',
      run: '[RUT#1]',
    });
    expect(mask([{ dni: 12345678 }, { dni: '12345678' }, { DNI: '12.345.678' }], { turn })).toEqual(
      [{ dni: '[DNI#1]' }, { dni: '[DNI#1]' }, { DNI: '[DNI#1]' }],
    );
    expect(mask({ birthDate: '1970-01-01', dob: 19700101 }, { turn })).toEqual({
      birthDate: '[DOB#1]',
      dob: '[DOB#1]',
    });
    // A CPF with a leading zero, stored as a number, has lost that zero: 10 digits.
    const cpf0 = cpf('012345678');
    expect(String(Number(cpf0))).toHaveLength(10);
    expect(mask({ cpf: Number(cpf0), cpfCnpj: Number(cpf0) }, { turn })).toEqual({
      cpf: '[CPF#1]',
      cpfCnpj: '[CPF#1]',
    });
    expect(mask(`cpf ${dotCpf(cpf0)}`, { turn })).toBe('cpf [CPF#1]');
    expect(mask({ cpf: 1234567 }, { turn })).toEqual({ cpf: '[CPF#2]' }); // too short to pad
    expect(mask({ cpf: Number(breakLast(cpf0)) }, { turn })).toEqual({ cpf: '[CPF#3]' }); // no CPF
  });

  it('masks an array under an identity key element by element, nested arrays included', () => {
    expect(mask({ addresses: ['Rua Um', null, 'Rua Dois', ['Rua Um']] })).toEqual({
      addresses: ['[ADDRESS#1]', null, '[ADDRESS#2]', ['[ADDRESS#1]']],
    });
  });

  it('names the token after what the value IS when the whole value is an identifier', () => {
    const out = maskToolResult({
      identificationNumber: dotCpf(CPF_A),
      note: `titular ${CPF_A}`,
      nationality: 'Brasileira',
    });
    expect(out.value).toEqual({
      identificationNumber: '[CPF#1]',
      note: 'titular [CPF#1]',
      nationality: '[NATIONALITY#1]',
    });
  });

  // PIA S2: the five fields Insights ruling 37 names — CPF, birthDate, identificationNumber,
  // nationality, primaryAddress — in the nesting its report datablocks use.
  it('walks nested objects and arrays, masking the five ruling-37 fields at every level', () => {
    const report = {
      company: { name: 'Synthetic Ltda', cnpj: '11.222.333/0001-81' },
      principals: [
        { name: 'Pessoa Um', CPF: CPF_A, birthDate: '1970-01-01', nationality: 'BR' },
        {
          name: 'Pessoa Dois',
          identificationNumber: 'X-99',
          primaryAddress: { streetAddress: { line1: 'Rua Dois, 2' }, postalCode: '00000-000' },
          notes: [`CPF ${dotCpf(CPF_B)}`, { comment: `ver ${CPF_A}` }],
        },
      ],
    };
    expect(mask(report)).toEqual({
      company: { name: 'Synthetic Ltda', cnpj: '11.222.333/0001-81' },
      principals: [
        { name: 'Pessoa Um', CPF: '[CPF#1]', birthDate: '[DOB#1]', nationality: '[NATIONALITY#1]' },
        {
          name: 'Pessoa Dois',
          identificationNumber: '[ID#1]',
          primaryAddress: '[ADDRESS#1]',
          notes: ['CPF [CPF#2]', { comment: 'ver [CPF#1]' }],
        },
      ],
    });
  });

  it('keys that hold person OR company ids keep a valid company id and mask everything else', () => {
    const out = mask({
      a: { cuit: dashCuit(CUIT_COMPANY) },
      b: { cuit: dashCuit(CUIT_PERSON) },
      c: { cuit: 'n/a' },
      d: { rfc: RFC_COMPANY },
      e: { rfc: RFC_PERSON },
      f: { ruc: RUC_COMPANY },
      g: { ruc: RUC_PERSON },
      h: { cpfCnpj: '11.222.333/0001-81' },
      i: { cpf_cnpj: dotCpf(CPF_A) },
      j: { cnpjCpf: '12.ABC.345/01DE-35' },
      k: { cpfCnpj: '11.222.333/0001-80' },
      l: { cuit: Number(CUIT_COMPANY) },
    });
    expect(out).toEqual({
      a: { cuit: '30-71234567-1' },
      b: { cuit: '[CUIT#1]' },
      c: { cuit: 'n/a' }, // a placeholder
      d: { rfc: RFC_COMPANY },
      e: { rfc: '[RFC#1]' },
      f: { ruc: RUC_COMPANY },
      g: { ruc: '[RUC#1]' },
      h: { cpfCnpj: '11.222.333/0001-81' },
      i: { cpf_cnpj: '[CPF#1]' },
      j: { cnpjCpf: '12.ABC.345/01DE-35' },
      k: { cpfCnpj: '[CPF#2]' },
      l: { cuit: Number(CUIT_COMPANY) },
    });
  });

  // The kit's MCP adapter serializes a tool payload to text (src/mcp/tools.ts), and a D1 TEXT
  // column can hold JSON: either way the key layer must still see the keys.
  it('masks a serialized payload as the value it is, the key layer included', () => {
    const payload = {
      dni: '12345678',
      birthDate: '1980-02-03',
      primaryAddress: 'Rua X 10',
      passport: 'AB123456',
    };
    expect(mask(JSON.stringify(payload))).toBe(
      '{"dni":"[DNI#1]","birthDate":"[DOB#1]","primaryAddress":"[ADDRESS#1]","passport":"[PASSPORT#1]"}',
    );
    expect(mask(`  ${JSON.stringify([payload.dni, { dni: payload.dni }], null, 2)}\n`)).toBe(
      '["12345678",{"dni":"[DNI#1]"}]',
    );
  });

  it('masks JSON held in a string field (a TEXT column returned unparsed)', () => {
    const row = {
      id: 1,
      principals_json: JSON.stringify([{ dni: '12345678', note: `CPF ${CPF_A}` }]),
    };
    expect(mask(row)).toEqual({
      id: 1,
      principals_json: '[{"dni":"[DNI#1]","note":"CPF [CPF#1]"}]',
    });
  });

  it('value-scans a string that is not whole JSON, and copies an allowed one as written', () => {
    const cut = `{"dni":"12345678","cpf":"${CPF_A}"`; // truncated: no closing brace
    expect(mask(cut)).toBe(`{"dni":"12345678","cpf":"[CPF#1]"`);
    expect(mask('[CPF#1] and [1, 2]')).toBe('(CPF#1) and [1, 2]');
    const raw = JSON.stringify({ dni: '12345678' });
    expect(mask({ blob: raw }, { allowRaw: ['blob'] })).toEqual({ blob: raw });
  });

  it('bounds serialized JSON by the same depth and budget, and fails closed past them', () => {
    const nested = JSON.stringify({ a: { dni: '12345678' } });
    // The string sits at depth 1, and what it serializes is its child, at depth 2.
    expect(maskToolResult({ s: nested }, { limits: { maxDepth: 3 } }).value).toEqual({
      s: '{"a":"[TRUNCATED]"}',
    });
    expect(maskToolResult({ s: nested }, { limits: { maxDepth: 2 } }).value).toEqual({
      s: TRUNCATED,
    });
    const out = maskToolResult(JSON.stringify({ dni: '12345678' }), { limits: { maxChars: 20 } });
    expect(out.value).toBe('{"[TRUNCATED]":"[TRUNCATED]"}');
    expect(out.truncated).toBe(true);
  });

  it('document-number keys keep a valid company id of any kind and mask everything else', () => {
    expect(
      mask({
        a: { documentNumber: CNPJ_A },
        b: { nroDoc: dashCuit(CUIT_COMPANY) },
        c: { numeroDocumento: RUC_COMPANY },
        d: { docNumber: RFC_COMPANY },
        e: { documentNumber: '12345678' },
        f: { nroDoc: dotCpf(CPF_A) },
      }),
    ).toEqual({
      a: { documentNumber: CNPJ_A },
      b: { nroDoc: '30-71234567-1' },
      c: { numeroDocumento: RUC_COMPANY },
      d: { docNumber: RFC_COMPANY },
      e: { documentNumber: '[ID#1]' },
      f: { nroDoc: '[CPF#1]' },
    });
  });

  // Review: the key cannot say which of the two a value that is both is, so it fails closed, as
  // the value layer does. Only a `ruc` key reads a RUC 20 as the company RUC it is named for.
  it('document-number keys mask a company id that is also a valid person id', () => {
    // A person CUIT 20 that is also a valid Peruvian company RUC 20 (about 9 in 11 of them are).
    expect(rucCheckDigit(CUIT_PERSON.slice(0, 10))).toBe(CUIT_PERSON.slice(10));
    // A CPF that is also a valid company CUIT (prefix 30), found at runtime.
    let cpfAlsoCuit = '';
    for (let n = 307_000_000; cpfAlsoCuit === ''; n++) {
      const id = cpf(String(n));
      if (cuitCheckDigit(id.slice(0, 10)) === id[10]) cpfAlsoCuit = id;
    }
    expect(
      mask({
        nroDoc: CUIT_PERSON,
        numeroDocumento: Number(CUIT_PERSON),
        documentNumber: dashCuit(CUIT_PERSON),
        docNumber: cpfAlsoCuit,
        comment: CUIT_PERSON,
        ruc: CUIT_PERSON,
      }),
    ).toEqual({
      nroDoc: '[CUIT#1]',
      numeroDocumento: '[CUIT#1]',
      documentNumber: '[CUIT#1]',
      docNumber: '[CPF#1]',
      comment: '[CUIT#1]',
      ruc: CUIT_PERSON,
    });
  });

  // A Postgres driver hands date columns over as Date objects; JSON.stringify and the MCP adapter
  // send their ISO string, so the masker reads the same string and masks it like one.
  it('reads a Date as its ISO string: masked under a birth-date key, sent as a date elsewhere', () => {
    const epoch = '1970-01-01T00:00:00.000Z';
    const { value, turn } = maskToolResult({
      birthDate: new Date(0),
      createdAt: new Date(0),
      invalid: new Date(Number.NaN),
      list: [new Date(0)],
    });
    expect(value).toEqual({ birthDate: '[DOB#1]', createdAt: epoch, invalid: null, list: [epoch] });
    expect(turn.tokens().get('[DOB#1]')).toBe(epoch);
  });
});

// ── allowRaw ───────────────────────────────────────────────────────────────────────────────────

describe('allowRaw — fields a DPO egressRuling lets through', () => {
  it('lets the named field through raw and masks the rest', () => {
    expect(mask({ cpf: CPF_A, birthDate: '1970-01-01' }, { allowRaw: ['birthDate'] })).toEqual({
      cpf: '[CPF#1]',
      birthDate: '1970-01-01',
    });
  });

  it('matches field names case- and separator-insensitively, never by prefix', () => {
    const out = mask(
      { birthDate: 'd1', BIRTHDATE: 'd2', 'birth-date': 'd3', principalBirthDate: 'd4' },
      { allowRaw: ['birth_date'] },
    );
    expect(out).toEqual({
      birthDate: 'd1',
      BIRTHDATE: 'd2',
      'birth-date': 'd3',
      principalBirthDate: '[DOB#1]',
    });
  });

  it('copies the whole subtree raw — the value layer included', () => {
    const address = { street: 'Rua Um', zip: '00000-000', owner: { cpf: CPF_A } };
    expect(mask({ address, other: CPF_A }, { allowRaw: ['address'] })).toEqual({
      address,
      other: '[CPF#1]',
    });
    expect(mask({ notes: `CPF ${CPF_A}` }, { allowRaw: ['notes'] })).toEqual({
      notes: `CPF ${CPF_A}`,
    });
  });

  it('matches an ordinal exactly: allowing cpf2 or addressLine2 allows no other field', () => {
    expect(
      mask({ cpf: '12', cpf1: '34', CPF: '56', cpf2: '78', cpf_2: '90' }, { allowRaw: ['cpf2'] }),
    ).toEqual({ cpf: '[CPF#1]', cpf1: '[CPF#2]', CPF: '[CPF#3]', cpf2: '78', cpf_2: '90' });
    expect(
      mask({ addressLine1: 'Rua Um 1', addressLine2: 'apto 2' }, { allowRaw: ['addressLine2'] }),
    ).toEqual({ addressLine1: '[ADDRESS#1]', addressLine2: 'apto 2' });
    expect(mask({ cpf: '12', cpf2: '34' }, { allowRaw: ['cpf'] })).toEqual({
      cpf: '12',
      cpf2: '[CPF#1]',
    });
  });

  it('refuses allowRaw that is not an array: a string would allow each of its letters', () => {
    for (const bad of ['cpf', null, { cpf: true }, 1]) {
      expect(() => maskToolResult({ c: '12' }, { allowRaw: bad as unknown as string[] })).toThrow(
        TypeError,
      );
    }
  });

  it('refuses an entry that names no field', () => {
    for (const bad of ['', '*', '  ', '__', '.-'] as const) {
      expect(() => maskToolResult({}, { allowRaw: [bad] })).toThrow(TypeError);
    }
    expect(() => maskToolResult({}, { allowRaw: [5 as unknown as string] })).toThrow(TypeError);
  });
});

// ── identityKeys ───────────────────────────────────────────────────────────────────────────────

describe("identityKeys — a route's own identity fields the lists do not name", () => {
  it('masks the named field whatever its value, and names a valid id by what it is', () => {
    expect(
      mask(
        { taxId: RUT_A, tax_id: '98', holder: { TAXID: dotCpf(CPF_A) }, other: RUT_A },
        { identityKeys: ['taxId'] },
      ),
    ).toEqual({ taxId: '[ID#1]', tax_id: '[ID#2]', holder: { TAXID: '[CPF#1]' }, other: RUT_A });
  });

  it('matches exactly, like allowRaw, and only ever masks more', () => {
    expect(mask({ taxIds: ['98'], companyTaxId: '98' }, { identityKeys: ['taxId'] })).toEqual({
      taxIds: ['98'],
      companyTaxId: '98',
    });
    // A person-or-company key loses its company exemption; a person key keeps its label.
    expect(
      mask({ cuit: dashCuit(CUIT_COMPANY), cpf: '12' }, { identityKeys: ['cuit', 'cpf'] }),
    ).toEqual({ cuit: '[CUIT#1]', cpf: '[CPF#1]' });
  });

  // Review: such a field was labelled ID, a label written in digits, so a value with no digit was
  // taken for a placeholder and went out raw.
  it('masks a field the lists do not name whatever it holds: no placeholder passes', () => {
    const identityKeys = ['lugarNac', 'estadoCivil', 'sexo', 'taxId'];
    const { value, turn } = maskToolResult(
      {
        lugarNac: 'Sao Paulo',
        estadoCivil: 'Casado',
        sexo: 'F',
        taxId: 'N/A',
        holder: { lugar_nac: 'Sao Paulo', tax_id: '000' },
      },
      { identityKeys },
    );
    expect(value).toEqual({
      lugarNac: '[ID#1]',
      estadoCivil: '[ID#2]',
      sexo: '[ID#3]',
      taxId: '[ID#4]',
      holder: { lugar_nac: '[ID#1]', tax_id: '[ID#5]' },
    });
    expect(turn.tokens().get('[ID#1]')).toBe('Sao Paulo');
    // A digit-written value is still keyed without its punctuation.
    expect(mask({ taxId: '12.345', tax_id: 12345 }, { identityKeys })).toEqual({
      taxId: '[ID#1]',
      tax_id: '[ID#1]',
    });
    // A field with a built-in label keeps that label's placeholder rule.
    expect(mask({ cpf: 'N/A', dni: '000' }, { identityKeys: ['cpf', 'dni'] })).toEqual({
      cpf: 'N/A',
      dni: '000',
    });
  });

  it('refuses a malformed list, and a field that is both allowed raw and an identity key', () => {
    for (const bad of ['taxId', null, [''], ['*']]) {
      expect(() => maskToolResult({}, { identityKeys: bad as unknown as string[] })).toThrow(
        TypeError,
      );
    }
    expect(() => maskToolResult({}, { allowRaw: ['tax_id'], identityKeys: ['taxId'] })).toThrow(
      TypeError,
    );
  });
});

// ── Tokens and the turn ────────────────────────────────────────────────────────────────────────

describe('tokens — stable within a turn, per label, never serialized', () => {
  it('pins the token grammar the DSR search relies on', () => {
    expect(MASK_LABELS).toEqual([
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
    ]);
    const re = new RegExp(`^${MASK_TOKEN_PATTERN}$`);
    for (const ok of ['[CPF#1]', '[ADDRESS#12]', '[BIRTHPLACE#3]']) expect(re.test(ok)).toBe(true);
    for (const no of ['[CPF#0]', '[cpf#1]', '[FOO#1]', '(CPF#1)', TRUNCATED, OMITTED]) {
      expect(re.test(no)).toBe(false);
    }
  });

  it('keeps one token per value across calls of the same turn, and restarts on a new turn', () => {
    const turn = new MaskTurn();
    expect(mask({ cpf: CPF_A }, { turn })).toEqual({ cpf: '[CPF#1]' });
    expect(mask(`de novo ${dotCpf(CPF_A)}, e ${CPF_B}`, { turn })).toBe(
      'de novo [CPF#1], e [CPF#2]',
    );
    expect(mask(dotRut(RUT_A), { turn })).toBe('[RUT#1]');
    expect(turn.size).toBe(3);
    expect(mask(CPF_B)).toBe('[CPF#1]'); // a fresh turn
  });

  it('gives equal objects one token whatever their key order', () => {
    const out = mask({
      address: [
        { a: 1, b: 2, lines: ['x', { c: 3, d: 4 }] },
        { lines: ['x', { d: 4, c: 3 }], b: 2, a: 1 },
        { a: 1, lines: ['x'] },
      ],
    });
    expect(out).toEqual({ address: ['[ADDRESS#1]', '[ADDRESS#1]', '[ADDRESS#2]'] });
  });

  it('maps token → raw value for the UI, as frozen snapshots', () => {
    const { turn } = maskToolResult({
      text: `x ${dotCpf(CPF_A)} y ${CPF_A}`,
      address: { street: 'Rua Um' },
    });
    const map = turn.tokens();
    expect([...map.entries()]).toEqual([
      ['[CPF#1]', '123.456.789-09'],
      ['[ADDRESS#1]', { street: 'Rua Um' }],
    ]);
    expect(Object.isFrozen(map.get('[ADDRESS#1]'))).toBe(true);
    (map as Map<string, JsonValue>).clear();
    expect(turn.size).toBe(2);
    expect(turn.tokens().size).toBe(2);
  });

  it('refuses to be serialized, and a structured clone carries nothing', () => {
    const result = maskToolResult({ cpf: CPF_A });
    expect(() => JSON.stringify(result.turn)).toThrow(TypeError);
    expect(() => JSON.stringify(result)).toThrow(TypeError);
    expect(JSON.stringify(result.value)).toBe('{"cpf":"[CPF#1]"}');
    const cloned = structuredClone(result.turn);
    expect(Object.keys(cloned)).toEqual([]);
    expect(JSON.stringify(Object.assign({}, cloned))).not.toContain(CPF_A);
  });

  // Plan P2 runs a turn in Workflow steps, and the map cannot leave the step that minted it.
  it('resumes in a later step from content-free counters: no number is reused in the turn', () => {
    const step1 = new MaskTurn();
    mask({ cpf: CPF_A, dob: '1970-01-01' }, { turn: step1 });
    expect(mask(dotCpf(CPF_B), { turn: step1 })).toBe('[CPF#2]');
    const saved = JSON.parse(JSON.stringify(step1.counters())); // what a step's state can carry
    expect(saved).toEqual({ CPF: 2, DOB: 1 });
    const step2 = new MaskTurn(saved);
    expect(mask(dotCpf(cpf('222333444')), { turn: step2 })).toBe('[CPF#3]');
    // The map did not travel: a value from the earlier step gets a NEW number, never an old one.
    expect(mask({ cpf: CPF_A, nationality: 'BR' }, { turn: step2 })).toEqual({
      cpf: '[CPF#4]',
      nationality: '[NATIONALITY#1]',
    });
    expect([...step2.tokens().keys()]).toEqual(['[CPF#3]', '[CPF#4]', '[NATIONALITY#1]']);
    expect(step2.counters()).toEqual({ CPF: 4, DOB: 1, NATIONALITY: 1 });
    expect(Object.isFrozen(step2.counters())).toBe(true);
    expect(new MaskTurn({}).counters()).toEqual({});
  });

  it('refuses counters it cannot trust: a reset would reuse numbers', () => {
    for (const bad of [null, [], 'CPF', { CPF: -1 }, { CPF: 1.5 }, { CPF: '2' }, { FOO: 1 }]) {
      expect(() => new MaskTurn(bad as never)).toThrow(TypeError);
    }
  });

  it('refuses a turn that is not a MaskTurn', () => {
    expect(() => maskToolResult('x', { turn: {} as MaskTurn })).toThrow(TypeError);
    expect(() => MaskTurn.prototype.tokens.call({} as MaskTurn)).toThrow(TypeError);
  });

  it('counts replacements without naming them', () => {
    const out = maskToolResult({ cpf: CPF_A, t: `${CPF_A} ${CPF_B}`, n: 'none' });
    expect(out.masked).toBe(3);
    expect(out.truncated).toBe(false);
  });

  it('rewrites token-shaped literals so every token in a result was minted here', () => {
    const turn = new MaskTurn();
    const out = mask(
      { 'see [ID#2]': 'and [CPF#1], [RUT#12], [FOO#1], [cpf#1]', cpf: CPF_A },
      { turn },
    );
    expect(out).toEqual({
      'see (ID#2)': 'and (CPF#1), (RUT#12), [FOO#1], [cpf#1]',
      cpf: '[CPF#1]',
    });
    for (const t of tokensIn(out)) expect(turn.tokens().has(t)).toBe(true);
  });
});

// ── Input safety ───────────────────────────────────────────────────────────────────────────────

describe('input safety', () => {
  it('never mutates the input (deep-frozen input works; a snapshot compares equal after)', () => {
    const input = deepFreeze({
      cpf: CPF_A,
      list: [{ address: 'Rua Um', text: `CPF ${CPF_B}` }, [1, 2, { dob: 'x' }]],
      raw: { nested: { cpf: CPF_A } },
    });
    const before = structuredClone(input);
    maskToolResult(input, { allowRaw: ['raw'] });
    expect(input).toEqual(before);
  });

  it('shares no object with the input, the raw subtrees included', () => {
    const input = { raw: { a: [1] }, other: { b: 2 } };
    const out = mask(input, { allowRaw: ['raw'] }) as { raw: { a: number[] }; other: object };
    expect(out.raw).not.toBe(input.raw);
    expect(out.raw.a).not.toBe(input.raw.a);
    expect(out.other).not.toBe(input.other);
    out.raw.a.push(9);
    expect(input.raw.a).toEqual([1]);
  });

  it('keeps a __proto__ key as data and pollutes nothing', () => {
    const input = JSON.parse(`{"__proto__": {"cpf": "${CPF_A}"}, "a": 1}`);
    const out = mask(input) as Record<string, JsonValue>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"cpf":"[CPF#1]"},"a":1}');
    expect(({} as Record<string, unknown>).cpf).toBeUndefined();
  });

  it('turns what JSON cannot hold into what JSON.stringify would, or OMITTED', () => {
    class Thing {
      cpf = CPF_A;
    }
    const nullProto = Object.assign(Object.create(null), { cpf: CPF_A });
    expect(
      mask({
        u: undefined,
        f: () => 1,
        s: Symbol('s'),
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        date: new Date(0),
        map: new Map([['cpf', CPF_A]]),
        thing: new Thing(),
        big: 12345678909n,
        list: [undefined, () => 1, Symbol('t')],
        nullProto,
      }),
    ).toEqual({
      nan: null,
      inf: null,
      date: '1970-01-01T00:00:00.000Z',
      map: OMITTED,
      thing: OMITTED,
      big: OMITTED,
      list: [null, null, null],
      nullProto: { cpf: '[CPF#1]' },
    });
    expect(mask(undefined)).toBeNull();
  });
});

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────

describe('limits — bounded, and fail closed past a bound', () => {
  const nest = (depth: number, leaf: JsonValue): JsonValue => {
    let v = leaf;
    for (let i = 0; i < depth; i++) v = [v];
    return v;
  };

  it('pins the ceilings', () => {
    expect(MASK_LIMITS).toEqual({ maxDepth: 64, maxNodes: 100_000, maxChars: 1_000_000 });
    expect(Object.isFrozen(MASK_LIMITS)).toBe(true);
  });

  it('replaces a container nested too deep, never its content', () => {
    const out = maskToolResult(nest(3, CPF_A), { limits: { maxDepth: 2 } });
    expect(out.value).toEqual([[TRUNCATED]]);
    expect(out.truncated).toBe(true);
    const deep = maskToolResult(nest(200, 'leaf'));
    expect(deep.truncated).toBe(true);
    expect(JSON.stringify(deep.value)).not.toContain('leaf');
    expect(maskToolResult(nest(60, 'leaf')).truncated).toBe(false);
  });

  it('stops after maxNodes: an array keeps its head and gains one TRUNCATED', () => {
    const out = maskToolResult([1, 2, 3, 4, 5, 6, 7, 8], { limits: { maxNodes: 4 } });
    expect(out.value).toEqual([1, 2, 3, TRUNCATED]);
    expect(out.truncated).toBe(true);
  });

  it('stops after maxNodes in an object with a TRUNCATED entry', () => {
    const out = maskToolResult({ a: 1, b: 2, c: 3, d: 4 }, { limits: { maxNodes: 3 } });
    expect(out.value).toEqual({ a: 1, b: 2, [TRUNCATED]: TRUNCATED });
  });

  it('replaces a string that would overrun maxChars WHOLE — no partial identifier', () => {
    const text = `${'x'.repeat(40)} ${dotCpf(CPF_A)}`;
    const out = maskToolResult({ a: 'short', b: text, c: 'after' }, { limits: { maxChars: 30 } });
    expect(out.value).toEqual({ a: 'short', b: TRUNCATED, [TRUNCATED]: TRUNCATED });
    expect(JSON.stringify(out.value)).not.toMatch(/[0-9]/);
  });

  it('in an array, a string cut by maxChars stands in for itself and one TRUNCATED for the rest', () => {
    const out = maskToolResult(['short', 'x'.repeat(50), 'after', 'more'], {
      limits: { maxChars: 20 },
    });
    expect(out.value).toEqual(['short', TRUNCATED, TRUNCATED]);
  });

  it('counts object keys against maxChars', () => {
    const out = maskToolResult({ ['k'.repeat(50)]: 1 }, { limits: { maxChars: 10 } });
    expect(out.value).toEqual({ [TRUNCATED]: TRUNCATED });
  });

  it('mints no token for an identity value the budget cut', () => {
    const out = maskToolResult({ cpf: 'x'.repeat(50) }, { limits: { maxChars: 10 } });
    expect(out.value).toEqual({ cpf: TRUNCATED });
    expect(out.turn.size).toBe(0);
  });

  it('caps an array under an identity key by depth and by nodes', () => {
    expect(mask({ address: nest(4, 'Rua') }, { limits: { maxDepth: 3 } })).toEqual({
      address: [[TRUNCATED]],
    });
    expect(mask({ address: ['a', 'b', 'c'] }, { limits: { maxNodes: 3 } })).toEqual({
      address: ['[ADDRESS#1]', TRUNCATED],
    });
    expect(mask({ a: 1, address: ['a'] }, { limits: { maxNodes: 2 } })).toEqual({
      a: 1,
      [TRUNCATED]: TRUNCATED,
    });
  });

  it('only ever tightens, and refuses a limit that is not a non-negative integer', () => {
    expect(maskToolResult(nest(70, 1), { limits: { maxDepth: 1_000 } }).truncated).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => maskToolResult(1, { limits: { maxNodes: bad } })).toThrow(TypeError);
    }
    expect(maskToolResult('x', { limits: { maxNodes: 0 } }).value).toBe(TRUNCATED);
  });

  it('truncates a default-size flood at exactly the node budget', () => {
    const flood = Array.from({ length: MASK_LIMITS.maxNodes + 10 }, (_, i) => i);
    const out = maskToolResult(flood);
    const arr = out.value as JsonValue[];
    expect(out.truncated).toBe(true);
    expect(arr.length).toBe(MASK_LIMITS.maxNodes);
    expect(arr.at(-1)).toBe(TRUNCATED);
  });
});

// ── Property tests over generated identifiers ──────────────────────────────────────────────────

describe('property — generated identifiers never survive, and invalid ones are left alone', () => {
  const WORDS = ['saldo', 'protesto', 'socio', 'cliente', 'total', 'ref', 'pedido', 'nota'];
  const digits = (r: () => number, n: number): string =>
    Array.from({ length: n }, () => Math.floor(r() * 10)).join('');
  const letters = (r: () => number, n: number, from = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'): string =>
    Array.from({ length: n }, () => from[Math.floor(r() * from.length)]).join('');
  const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const date = (r: () => number): string =>
    `${digits(r, 2)}${String(1 + Math.floor(r() * 12)).padStart(2, '0')}${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`;

  interface Generated {
    label: string;
    core: string; // the identifier with no punctuation — must never appear in the output
    written: string[]; // formats it is written in
  }

  function generate(r: () => number): Generated[] {
    let cpfId = cpf(digits(r, 9));
    while (/^(\d)\1{10}$/.test(cpfId)) cpfId = cpf(digits(r, 9));
    const rutId = rut(`${1 + Math.floor(r() * 9)}${digits(r, 7)}`);
    const cuitId = cuit(`${pick(r, ['20', '23', '24', '27'])}${digits(r, 8)}`);
    const rucId = ruc(`${pick(r, ['10', '15', '17'])}${digits(r, 8)}`);
    const curpId = curp(
      `${letters(r, 4)}${date(r)}${pick(r, ['H', 'M'])}${letters(r, 5)}${digits(r, 1)}`,
    );
    const rfcId = `${letters(r, 4)}${date(r)}${letters(r, 2)}${digits(r, 1)}`;
    return [
      {
        label: 'CPF',
        core: cpfId,
        written: [cpfId, dotCpf(cpfId), dotCpf(cpfId).replace(/[.-]/g, pick(r, ['-', '\u2011']))],
      },
      {
        label: 'RUT',
        core: rutId,
        written: [
          dotRut(rutId),
          `${rutId.slice(0, -1)}-${rutId.slice(-1)}`,
          dotRut(rutId).replace('-', '\u2013'),
        ],
      },
      {
        label: 'CUIT',
        core: cuitId,
        written: [dashCuit(cuitId), `${cuitId.slice(0, 2)}-${dotRut(cuitId.slice(2))}`],
      },
      { label: 'RUC', core: rucId, written: [rucId] },
      { label: 'CURP', core: curpId, written: [curpId, curpId.toLowerCase()] },
      {
        label: 'RFC',
        core: rfcId,
        written: [rfcId, `${rfcId.slice(0, 4)} ${rfcId.slice(4, 10)} ${rfcId.slice(10)}`],
      },
    ];
  }

  function embed(r: () => number, pieces: string[]): JsonValue {
    // Scatter the pieces through a random nested structure of objects, arrays and sentences.
    const root: Record<string, JsonValue> = {};
    let cursor: Record<string, JsonValue> | JsonValue[] = root;
    for (const piece of pieces) {
      const sentence = `${pick(r, WORDS)} ${piece}${pick(r, ['', '.', ',', ';', ' ok'])}`;
      const shape = Math.floor(r() * 4);
      if (Array.isArray(cursor)) cursor.push(sentence);
      else cursor[`${pick(r, WORDS)}_${Math.floor(r() * 1e6)}`] = sentence;
      if (shape === 1) {
        const next: JsonValue[] = [];
        if (Array.isArray(cursor)) cursor.push(next);
        else cursor[`list_${Math.floor(r() * 1e6)}`] = next;
        cursor = next;
      } else if (shape === 2) {
        const next: Record<string, JsonValue> = {};
        if (Array.isArray(cursor)) cursor.push(next);
        else cursor[`obj_${Math.floor(r() * 1e6)}`] = next;
        cursor = next;
      }
    }
    return root;
  }

  it('masks every valid identifier in every format, one token per identifier', () => {
    const r = prng(0xc3);
    for (let round = 0; round < 200; round++) {
      const ids = generate(r);
      const pieces = ids.flatMap((g) => g.written);
      const { value, turn } = maskToolResult(embed(r, pieces));
      const json = JSON.stringify(value);
      for (const g of ids) {
        expect(json, `${g.label} ${g.core} (round ${round})`).not.toContain(g.core);
        for (const w of g.written) expect(json).not.toContain(w);
      }
      // One token per identifier, whatever format and wherever it appeared; all of them minted.
      expect(turn.size).toBe(ids.length);
      const seen = new Set(tokensIn(value));
      expect(seen.size).toBe(ids.length);
      for (const t of seen) expect(turn.tokens().has(t)).toBe(true);
    }
  });

  it('leaves identifiers with a failed check digit exactly as written', () => {
    const r = prng(0x404);
    for (let round = 0; round < 200; round++) {
      // Leading digits 3-9: an 11-digit run can then be neither a person CUIT nor a person RUC.
      const cpfBad = breakLast(cpf(`${3 + Math.floor(r() * 7)}${digits(r, 8)}`));
      const rutBad = breakLast(rut(`${1 + Math.floor(r() * 9)}${digits(r, 7)}`));
      const curpBad = breakLast(curp(`${letters(r, 4)}${date(r)}H${letters(r, 5)}${digits(r, 1)}`));
      const cuitBad = breakLast(cuit(`27${digits(r, 8)}`));
      // A bare 11-digit run is tried as a CPF first; one in a hundred broken CUITs is a valid CPF.
      const isCpf = (d: string) => cpfCheckDigits(d.slice(0, 9)) === d.slice(9);
      const pieces = [
        cpfBad,
        dotCpf(cpfBad),
        `${rutBad.slice(0, -1)}-${rutBad.slice(-1)}`,
        curpBad,
        // Written without the RUT-shaped `-D` tail, so a RUT match cannot hide in it.
        ...(isCpf(cuitBad) ? [] : [cuitBad]),
      ];
      const input = embed(r, pieces);
      const out = maskToolResult(input);
      expect(out.value, `round ${round}`).toEqual(input);
      expect(out.masked).toBe(0);
    }
  });
});
