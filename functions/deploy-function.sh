#!/bin/bash

API_NAME=$1

cd API_NAME

SLS_DEBUG=* sls deploy --stage local