#! /bin/bash

echo "Zipping up the code"
sls package --stage local

echo "Redeploying it"
awslocal lambda update-function-code --function-name 'float-api-local-accrue' --zip-file fileb://.serverless/float-api.zip
