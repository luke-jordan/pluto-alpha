#!/bin/bash

API_NAME=$1
FUNCTION_NAME=$2

sls create --template aws-nodejs --path $API_NAME

cp ../templates/serverless/sls-template.yml $API_NAME/serverless.yml
# bring in the npm default so we avoid package-lock, which wipes symlinks, for very little gain
cp ../templates/serverless/.npmrc $API_NAME/.npmrc
# copy in our linting defaults
cp ../templates/serverless/.eslintrc.js $API_NAME/.eslintrc.js

cd $API_NAME

sed -i "s/<<API_NAME>>/$API_NAME/" serverless.yml
sed -i "s/<<FUNCTION_NAME>>/$FUNCTION_NAME/" serverless.yml

npm init

npm i --sav config debug uuid
npm i --save-dev chai chai-uuid mocha nyc
npm i --save-dev serverless-localstack
npm i --save-dev eslint eslint-plugin-chai-friendly

mkdir test
cd test
touch unit.js

cd ..
mkdir config
cd config
touch default.json
