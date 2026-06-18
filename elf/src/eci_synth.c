/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * eci_synth.c -- standalone one-shot ELF synthesizer for ecobox.
 *
 * A tiny CLI around the vendored eci/ wrapper. It does NOT go through
 * speech-dispatcher: ecobox's TTS provider spawns one process per synthesis
 * unit, feeds it UTF-8 text on stdin, and reads a mono 16-bit WAV back on
 * stdout (which the server transcodes to MP3 with ffmpeg). Engine init +
 * synthesis of a sentence is ~10 ms, so per-call spawning is fine and keeps
 * each synthesis fully isolated from the Node process.
 *
 * Usage:
 *   eci_synth --list                       # JSON voice catalogue -> stdout
 *   eci_synth --lib-dir DIR --voice-id ID [voice params]  # stdin text -> WAV
 *
 * --lib-dir holds eci.so + the language .so files (defaults to the ELF_LIB_DIR
 * env var). --voice-id is "<Preset>-<lang>-<REGION>" (e.g. "Reed-en-US"),
 * matching the ids emitted by --list.
 *
 * Optional voice params override the selected preset's built-in knobs. Each
 * takes a 0..100 value; when omitted, the preset's own value is kept:
 *   --head-size N --pitch N --inflection N --roughness N --breathiness N --volume N
 *
 * --rate M bakes the reading speed into synthesis (the engine's native eciSpeed)
 * instead of time-stretching the audio client-side. M is a multiplier where 1.0
 * is the preset's natural pace; it maps to eciSpeed (0..250). A formant voice
 * stays crisp when sped up this way, unlike <audio>.playbackRate stretching.
 * When --rate is omitted the preset's default pace is kept (no behavior change).
 * Because rate now affects the samples, ecobox folds it into the audio-cache key.
 *
 * Copyright (C) 2026 -- ecobox, building on the GPL ECI speech-dispatcher wrapper.
 */
#include "eci/engine.h"
#include "eci/eci.h"
#include "eci/languages.h"
#include "eci/voices.h"

#include <ctype.h>
#include <errno.h>
#include <iconv.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* CJK is gated out: the converted chs/cht/jpn/kor modules crash mid-utterance
 * (unrebased function pointer); same gate as the speech-dispatcher module. */
static int lang_is_cjk(const LangEntry *L) {
    const char *s = L->so_name;
    return strcmp(s, "jpn.so") == 0 || strcmp(s, "kor.so") == 0 ||
           strcmp(s, "chs.so") == 0 || strcmp(s, "cht.so") == 0;
}

/* "en" + "us" -> "en-US" into buf. */
static void ietf_tag(const LangEntry *L, char *buf, size_t n) {
    snprintf(buf, n, "%s-%s", L->iso_lang, L->iso_variant);
    for (char *p = buf + strlen(L->iso_lang) + 1; *p; p++) *p = (char)toupper((unsigned char)*p);
}

/* --list: emit the 8 presets x each available (non-CJK) language as JSON. */
static int do_list(void) {
    printf("[");
    int first = 1;
    for (int li = 0; li < N_LANGS; li++) {
        const LangEntry *L = &g_langs[li];
        if (lang_is_cjk(L)) continue;
        char tag[16];
        ietf_tag(L, tag, sizeof(tag));
        for (int vi = 0; vi < N_VOICE_PRESETS; vi++) {
            const char *vname = voice_display_name(vi, L->iso_lang);
            if (!first) printf(",");
            first = 0;
            printf("{\"id\":\"%s-%s\",\"name\":\"%s \\u2014 %s\",\"lang\":\"%s\"}",
                   vname, tag, vname, L->human, tag);
        }
    }
    printf("]\n");
    return 0;
}

/* Parse "Reed-en-US" -> voice slot + ECI dialect. Preset names are all single
 * tokens with no '-', so the first '-' splits name from the IETF tag. */
static int parse_voice_id(const char *id, int *slot, int *dialect) {
    const char *dash = strchr(id, '-');
    if (!dash || dash == id) return -1;
    char name[32];
    size_t nl = (size_t)(dash - id);
    if (nl >= sizeof(name)) return -1;
    memcpy(name, id, nl);
    name[nl] = 0;

    int s = voice_find_by_name(name);
    if (s < 0) return -1;
    const LangEntry *L = lang_by_iso(dash + 1);
    if (!L || lang_is_cjk(L)) return -1;
    *slot = s;
    *dialect = L->eci_dialect;
    return 0;
}

/* Generate an eci.ini for every available (non-CJK) language with absolute
 * Path= entries, in a fresh temp dir, and chdir there -- the engine reads
 * eci.ini from the cwd at eciNewEx time. Returns 0, fills tmpdir. */
static int setup_workdir(const char *lib_dir, char *tmpdir, size_t n) {
    snprintf(tmpdir, n, "/tmp/eci_synth.XXXXXX");
    if (!mkdtemp(tmpdir)) {
        fprintf(stderr, "eci_synth: mkdtemp failed: %s\n", strerror(errno));
        return -1;
    }
    char ini[ELOQ_PATH_MAX + 32];
    snprintf(ini, sizeof(ini), "%s/eci.ini", tmpdir);
    FILE *f = fopen(ini, "w");
    if (!f) {
        fprintf(stderr, "eci_synth: cannot write %s: %s\n", ini, strerror(errno));
        return -1;
    }
    for (int i = 0; i < N_LANGS; i++) {
        const LangEntry *L = &g_langs[i];
        if (lang_is_cjk(L)) continue;
        fprintf(f, "[%d.%d]\nPath=%s/%s\nVersion=6.1\n\n",
                L->ini_major, L->ini_minor, lib_dir, L->so_name);
    }
    fclose(f);
    if (chdir(tmpdir) != 0) {
        fprintf(stderr, "eci_synth: chdir(%s): %s\n", tmpdir, strerror(errno));
        return -1;
    }
    return 0;
}

static void cleanup_workdir(const char *tmpdir) {
    if (!tmpdir[0]) return;
    char p[ELOQ_PATH_MAX + 32];
    snprintf(p, sizeof(p), "%s/eci.ini", tmpdir); unlink(p);
    snprintf(p, sizeof(p), "%s/eci.dbg", tmpdir); unlink(p);
    rmdir(tmpdir);
}

/* Convert UTF-8 stdin text to the engine's expected encoding (cp1252 for the
 * Western languages; CJK is gated out so we never need the others here).
 * Returns a malloc'd, NUL-terminated buffer; falls back to a verbatim copy if
 * iconv is unavailable. */
static char *encode_for_dialect(const char *utf8, size_t in_len, int dialect) {
    const char *enc = lang_encoding_for(dialect);  /* "cp1252" for non-CJK */
    char to[32];
    snprintf(to, sizeof(to), "%s//TRANSLIT", enc);
    iconv_t cd = iconv_open(to, "UTF-8");
    if (cd == (iconv_t)-1) return strndup(utf8, in_len);

    size_t out_cap = in_len * 2 + 16;
    char *out = malloc(out_cap);
    if (!out) { iconv_close(cd); return NULL; }

    char *inp = (char *)utf8, *outp = out;
    size_t inleft = in_len, outleft = out_cap - 1;
    while (inleft > 0) {
        size_t r = iconv(cd, &inp, &inleft, &outp, &outleft);
        if (r == (size_t)-1) {
            if (errno == EILSEQ || errno == EINVAL) {
                /* Unmappable byte even after //TRANSLIT: skip it. */
                inp++; inleft--;
                continue;
            }
            if (errno == E2BIG) {
                size_t used = (size_t)(outp - out);
                out_cap *= 2;
                char *n2 = realloc(out, out_cap);
                if (!n2) { free(out); iconv_close(cd); return NULL; }
                out = n2; outp = out + used; outleft = out_cap - 1 - used;
                continue;
            }
            break;
        }
    }
    *outp = 0;
    iconv_close(cd);
    return out;
}

/* ---- PCM capture ---- */
#define CHUNK_SAMPLES 8192
static int16_t  g_chunk[CHUNK_SAMPLES];
static int16_t *g_pcm = NULL;
static long     g_len = 0, g_cap = 0;

static enum ECICallbackReturn pcm_cb(ECIHand h, enum ECIMessage msg, long lParam, void *data) {
    (void)h; (void)data;
    if (msg != eciWaveformBuffer || lParam <= 0) return eciDataProcessed;
    long need = g_len + lParam;
    if (need > g_cap) {
        long nc = g_cap ? g_cap * 2 : 65536;
        while (nc < need) nc *= 2;
        int16_t *p = realloc(g_pcm, (size_t)nc * sizeof(int16_t));
        if (!p) return eciDataAbort;
        g_pcm = p; g_cap = nc;
    }
    memcpy(g_pcm + g_len, g_chunk, (size_t)lParam * sizeof(int16_t));
    g_len += lParam;
    return eciDataProcessed;
}

static void put_u32(unsigned char *b, uint32_t v) { b[0]=v; b[1]=v>>8; b[2]=v>>16; b[3]=v>>24; }
static void put_u16(unsigned char *b, uint16_t v) { b[0]=v; b[1]=v>>8; }

/* Write a canonical 44-byte PCM WAV header + samples to stdout. */
static void write_wav(int sample_rate_hz) {
    uint32_t data_bytes = (uint32_t)(g_len * 2);
    unsigned char hdr[44];
    memcpy(hdr, "RIFF", 4);
    put_u32(hdr + 4, 36 + data_bytes);
    memcpy(hdr + 8, "WAVEfmt ", 8);
    put_u32(hdr + 16, 16);            /* fmt chunk size */
    put_u16(hdr + 20, 1);             /* PCM */
    put_u16(hdr + 22, 1);             /* mono */
    put_u32(hdr + 24, (uint32_t)sample_rate_hz);
    put_u32(hdr + 28, (uint32_t)sample_rate_hz * 2); /* byte rate */
    put_u16(hdr + 32, 2);             /* block align */
    put_u16(hdr + 34, 16);            /* bits per sample */
    memcpy(hdr + 36, "data", 4);
    put_u32(hdr + 40, data_bytes);
    fwrite(hdr, 1, sizeof(hdr), stdout);
    if (g_len > 0) fwrite(g_pcm, 2, (size_t)g_len, stdout);
    fflush(stdout);
}

static char *read_all_stdin(size_t *out_len) {
    size_t cap = 65536, len = 0;
    char *buf = malloc(cap);
    if (!buf) return NULL;
    size_t r;
    while ((r = fread(buf + len, 1, cap - len, stdin)) > 0) {
        len += r;
        if (len == cap) {
            cap *= 2;
            char *n = realloc(buf, cap);
            if (!n) { free(buf); return NULL; }
            buf = n;
        }
    }
    buf[len] = 0;
    *out_len = len;
    return buf;
}

/* Parse a 0..100 voice-param argument; clamps into range. Returns -1 ("unset")
 * for non-numeric input so a malformed flag just keeps the preset's value. */
static int parse_pct(const char *s) {
    if (!s || !s[0]) return -1;
    char *end = NULL;
    long v = strtol(s, &end, 10);
    if (end == s) return -1;
    if (v < 0)   v = 0;
    if (v > 100) v = 100;
    return (int)v;
}

/* Map a playback-rate multiplier (1.0 = the preset's natural pace = eciSpeed 50)
 * to an ECI eciSpeed value (0..250). eciSpeed is ~logarithmic in perceived rate,
 * so this is an empirical fit (ln(mult) ~ 0.019 per eciSpeed unit) chosen so the
 * synthesized duration scales ~1/multiplier across the reader's 0.5..5x range;
 * see elf/README.md. m=1.0 -> 50 (unchanged pace), m=2.2 -> ~92, m=5.0 -> ~135. */
static int rate_to_eci_speed(double m) {
    if (!(m > 0)) m = 1.0;
    int s = (int)round(50.0 + log(m) / 0.019);
    if (s < 0)   s = 0;
    if (s > 250) s = 250;
    return s;
}

int main(int argc, char **argv) {
    const char *lib_dir = getenv("ELF_LIB_DIR");
    const char *voice_id = NULL;
    int list = 0;
    /* Voice-param overrides; -1 == unset (keep the preset's own value). */
    int p_head = -1, p_pitch = -1, p_infl = -1, p_rough = -1, p_breath = -1, p_vol = -1;
    /* Speech-rate multiplier; <0 == unset (keep the preset's default pace). */
    double rate = -1.0;

    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--list")) list = 1;
        else if (!strcmp(argv[i], "--lib-dir") && i + 1 < argc) lib_dir = argv[++i];
        else if (!strcmp(argv[i], "--voice-id") && i + 1 < argc) voice_id = argv[++i];
        else if (!strcmp(argv[i], "--head-size") && i + 1 < argc) p_head = parse_pct(argv[++i]);
        else if (!strcmp(argv[i], "--pitch") && i + 1 < argc) p_pitch = parse_pct(argv[++i]);
        else if (!strcmp(argv[i], "--inflection") && i + 1 < argc) p_infl = parse_pct(argv[++i]);
        else if (!strcmp(argv[i], "--roughness") && i + 1 < argc) p_rough = parse_pct(argv[++i]);
        else if (!strcmp(argv[i], "--breathiness") && i + 1 < argc) p_breath = parse_pct(argv[++i]);
        else if (!strcmp(argv[i], "--volume") && i + 1 < argc) p_vol = parse_pct(argv[++i]);
        else if (!strcmp(argv[i], "--rate") && i + 1 < argc) rate = strtod(argv[++i], NULL);
        else { fprintf(stderr, "eci_synth: unknown arg '%s'\n", argv[i]); return 2; }
    }

    if (list) return do_list();

    if (!lib_dir || !lib_dir[0]) {
        fprintf(stderr, "eci_synth: --lib-dir (or ELF_LIB_DIR) required\n");
        return 2;
    }
    int slot = 0, dialect = eciGeneralAmericanEnglish;
    if (voice_id && parse_voice_id(voice_id, &slot, &dialect) != 0) {
        fprintf(stderr, "eci_synth: bad --voice-id '%s'\n", voice_id);
        return 2;
    }

    size_t in_len = 0;
    char *utf8 = read_all_stdin(&in_len);
    if (!utf8) { fprintf(stderr, "eci_synth: OOM reading stdin\n"); return 1; }
    if (in_len == 0) { free(utf8); return 0; }  /* nothing to say */

    char workdir[ELOQ_PATH_MAX + 32] = {0};
    if (setup_workdir(lib_dir, workdir, sizeof(workdir)) != 0) { free(utf8); return 1; }

    char eci_so[ELOQ_PATH_MAX + 16];
    snprintf(eci_so, sizeof(eci_so), "%s/eci.so", lib_dir);

    EciEngine eng;
    char *err = NULL;
    if (engine_open(&eng, eci_so, dialect, 1 /* 11025 Hz */,
                    pcm_cb, NULL, g_chunk, CHUNK_SAMPLES, &err) != 0) {
        fprintf(stderr, "eci_synth: engine_open failed: %s\n", err ? err : "?");
        free(err); free(utf8); cleanup_workdir(workdir);
        return 1;
    }

    /* Load the selected preset into slot 0; preset defaults for pitch/vol. The
     * preset's default pace (eciSpeed 50) is kept unless --rate overrides it below. */
    voice_activate(&eng.api, eng.h, slot, INT_MIN, INT_MIN, INT_MIN, NULL);

    /* Apply any caller-supplied voice-param overrides on top of the preset.
     * Each is 0..100 (or -1 = leave the preset's value untouched). */
    if (p_head   >= 0) eng.api.SetVoiceParam(eng.h, ECI_ACTIVE_SLOT, eciHeadSize,         p_head);
    if (p_pitch  >= 0) eng.api.SetVoiceParam(eng.h, ECI_ACTIVE_SLOT, eciPitchBaseline,    p_pitch);
    if (p_infl   >= 0) eng.api.SetVoiceParam(eng.h, ECI_ACTIVE_SLOT, eciPitchFluctuation, p_infl);
    if (p_rough  >= 0) eng.api.SetVoiceParam(eng.h, ECI_ACTIVE_SLOT, eciRoughness,        p_rough);
    if (p_breath >= 0) eng.api.SetVoiceParam(eng.h, ECI_ACTIVE_SLOT, eciBreathiness,      p_breath);
    if (p_vol    >= 0) eng.api.SetVoiceParam(eng.h, ECI_ACTIVE_SLOT, eciVolume,           p_vol);

    /* Native speech rate: ecobox bakes the reading speed into synthesis (eciSpeed)
     * rather than time-stretching the audio client-side, so the formant voice stays
     * crisp when sped up. Applied last so it wins; only when --rate was given. */
    if (rate > 0) eng.api.SetVoiceParam(eng.h, ECI_ACTIVE_SLOT, eciSpeed, rate_to_eci_speed(rate));

    char *text = encode_for_dialect(utf8, in_len, dialect);
    free(utf8);
    if (!text) { fprintf(stderr, "eci_synth: OOM encoding\n"); engine_close(&eng); cleanup_workdir(workdir); return 1; }

    eng.api.AddText(eng.h, text);
    eng.api.Synthesize(eng.h);
    eng.api.Synchronize(eng.h);
    /* Drain guard in case Synchronize returns before the worker is done
     * (Apple's build is normally synchronous here, but be safe). */
    for (int i = 0; i < 20000 && eng.api.Speaking(eng.h); i++) usleep(1000);
    free(text);

    write_wav(eng.sample_rate_hz);

    engine_close(&eng);
    free(g_pcm);
    cleanup_workdir(workdir);
    return 0;
}
