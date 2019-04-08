#!/bin/bash

API_NAME=$1
FUNCTION_NAME=$2

sls create --template aws-nodejs --path $API_NAME

cp ../templates/serverless/sls-template.yml $API_NAME/serverless.yml

cd $API_NAME

sed -i "s/<<API_NAME>>/$API_NAME/" serverless.yml
sed -i "s/<<FUNCTION_NAME>>/$FUNCTION_NAME/" serverless.yml

npm init

npm i --sav config debug uuid
npm i --save-dev chai chai-uuid mocha
npm i --save-dev serverless-localstack

# npm link serverless-localstack

mkdir test
cd test
touch unit.js

cd ..
mkdir config
cd config
touch default.json
