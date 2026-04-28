/**
 * Artifact barrel — replaces filesystem-based loadArtifacts().
 * All core and user artifacts are imported statically and exported as an array.
 */

// Core artifacts
import branch from './core/branch.js';
import delay from './core/delay.js';
import filter from './core/filter.js';
import http from './core/http.js';
import jsonParse from './core/jsonParse.js';
import jsonStringify from './core/jsonStringify.js';
import logProcess from './core/log-process.js';
import loop from './core/loop.js';
import map from './core/map.js';
import merge from './core/merge.js';
import parseRequest from './core/parseRequest.js';
import parseResponse from './core/parseResponse.js';
import retry from './core/retry.js';
import split from './core/split.js';
import storeGet from './core/storeGet.js';
import storeSet from './core/storeSet.js';
import switchNode from './core/switchNode.js';
import template from './core/template.js';
import transform from './core/transform.js';
import validate from './core/validate.js';

// User artifacts
import fetcher from './user/fetcher.js';
import logger from './user/logger.js';
import pipeline from './user/pipeline.js';
import whatsappPipeline from './user/whatsapp-pipeline.js';
import whatsappResponder from './user/whatsapp-responder.js';
import whatsappRouter from './user/whatsapp-router.js';

export const allArtifacts = [
    // Core
    branch, delay, filter, http, jsonParse, jsonStringify,
    logProcess, loop, map, merge, parseRequest, parseResponse,
    retry, split, storeGet, storeSet, switchNode, template,
    transform, validate,
    // User
    fetcher, logger, pipeline,
    whatsappPipeline, whatsappResponder, whatsappRouter,
];
