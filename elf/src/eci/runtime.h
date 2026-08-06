/*
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * eci/runtime.h -- dynamically-loaded view of the IBM ECI runtime
 * (eci.so via dlopen on POSIX, ECI.DLL via LoadLibrary on Windows).
 *
 * Copyright (C) 2026 Mudb0y / Stas Przecinek
 */
#ifndef SD_ELOQUENCE_ECI_RUNTIME_H
#define SD_ELOQUENCE_ECI_RUNTIME_H

#include "eci.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Dictionary types (IBM SDK 6.7.4 §"Dictionaries"). Declared here because we
 * load the dict entry points via the same dlsym pass. */
typedef void *ECIDictHand;
#define NULL_DICT_HAND 0
enum ECIDictError {
    DictNoError = 0,
    DictFileNotFound,
    DictOutOfMemory,
    DictInternalError,
    DictNoEntry,
    DictErrLookUpKey,
    DictAccessError,
    DictInvalidVolume
};
enum ECIDictVolume {
    eciMainDict    = 0,
    eciRootDict    = 1,
    eciAbbvDict    = 2,
    eciMainDictExt = 3
};

/* Every entry point carries ECI_CALL -- __stdcall on Windows, cdecl elsewhere.
 * See the note in eci.h; this is an ABI requirement, not decoration. */
typedef struct EciApi {
    /* Lifecycle */
    ECIHand   (ECI_CALL *New)(void);
    ECIHand   (ECI_CALL *NewEx)(enum ECILanguageDialect);
    ECIHand   (ECI_CALL *Delete)(ECIHand);
    Boolean   (ECI_CALL *Reset)(ECIHand);
    Boolean   (ECI_CALL *IsBeingReentered)(ECIHand);
    void      (ECI_CALL *Version)(char *pBuffer);

    /* Diagnostics */
    int       (ECI_CALL *ProgStatus)(ECIHand);
    void      (ECI_CALL *ErrorMessage)(ECIHand, void *buffer);
    void      (ECI_CALL *ClearErrors)(ECIHand);
    Boolean   (ECI_CALL *TestPhrase)(ECIHand);

    /* Single-shot speak */
    Boolean   (ECI_CALL *SpeakText)(ECIInputText pText, Boolean bAnnotationsInTextPhrase);
    Boolean   (ECI_CALL *SpeakTextEx)(ECIInputText pText, Boolean bAnnotationsInTextPhrase,
                                      enum ECILanguageDialect);

    /* Parameters */
    int       (ECI_CALL *GetParam)(ECIHand, enum ECIParam);
    int       (ECI_CALL *SetParam)(ECIHand, enum ECIParam, int);
    int       (ECI_CALL *GetDefaultParam)(enum ECIParam);
    int       (ECI_CALL *SetDefaultParam)(enum ECIParam, int);

    /* Voices */
    Boolean   (ECI_CALL *CopyVoice)(ECIHand, int iVoiceFrom, int iVoiceTo);
    Boolean   (ECI_CALL *GetVoiceName)(ECIHand, int iVoice, void *pBuffer);
    Boolean   (ECI_CALL *SetVoiceName)(ECIHand, int iVoice, const void *pBuffer);
    int       (ECI_CALL *GetVoiceParam)(ECIHand, int iVoice, enum ECIVoiceParam);
    int       (ECI_CALL *SetVoiceParam)(ECIHand, int iVoice, enum ECIVoiceParam, int);

    /* Synthesis queue */
    Boolean   (ECI_CALL *AddText)(ECIHand, ECIInputText);
    Boolean   (ECI_CALL *InsertIndex)(ECIHand, int);
    Boolean   (ECI_CALL *Synthesize)(ECIHand);
    Boolean   (ECI_CALL *SynthesizeFile)(ECIHand, const void *pFilename);
    Boolean   (ECI_CALL *ClearInput)(ECIHand);
    Boolean   (ECI_CALL *GeneratePhonemes)(ECIHand, int iSize, void *pBuffer);
    int       (ECI_CALL *GetIndex)(ECIHand);

    /* Playback control */
    Boolean   (ECI_CALL *Stop)(ECIHand);
    Boolean   (ECI_CALL *Speaking)(ECIHand);
    Boolean   (ECI_CALL *Synchronize)(ECIHand);
    Boolean   (ECI_CALL *Pause)(ECIHand, Boolean On);

    /* Output routing */
    Boolean   (ECI_CALL *SetOutputBuffer)(ECIHand, int iSize, short *psBuffer);
    Boolean   (ECI_CALL *SetOutputFilename)(ECIHand, const void *pFilename);
    Boolean   (ECI_CALL *SetOutputDevice)(ECIHand, int iDevNum);

    /* Callbacks */
    void      (ECI_CALL *RegisterCallback)(ECIHand, ECICallback, void *pData);

    /* Languages */
    int       (ECI_CALL *GetAvailableLanguages)(enum ECILanguageDialect *aLanguages,
                                                int *nLanguages);

    /* Dictionaries */
    ECIDictHand       (ECI_CALL *NewDict)(ECIHand);
    ECIDictHand       (ECI_CALL *GetDict)(ECIHand);
    enum ECIDictError (ECI_CALL *SetDict)(ECIHand, ECIDictHand);
    ECIDictHand       (ECI_CALL *DeleteDict)(ECIHand, ECIDictHand);
    enum ECIDictError (ECI_CALL *LoadDict)(ECIHand, ECIDictHand,
                                           enum ECIDictVolume, ECIInputText pFilename);
} EciApi;

/* Load the ECI runtime at `eci_lib_path` (an absolute path to eci.so on POSIX
 * or ECI.DLL on Windows) and fill `api`. Returns 0, or -1 with a heap-allocated
 * message in *errmsg. Optional entry points may be left NULL -- see runtime.c. */
int  eci_runtime_open(const char *eci_lib_path, EciApi *api, char **errmsg);
void eci_runtime_close(void);

#ifdef __cplusplus
}
#endif

#endif
