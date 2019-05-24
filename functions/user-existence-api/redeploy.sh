#! /bin/bash

echo "Zipping up the code"
sls package --stage local

echo "Redeploying it"
awslocal lambda update-function-code --function-name 'create-account' --zip-file fileb://.serverless/user-existence-api.zip
