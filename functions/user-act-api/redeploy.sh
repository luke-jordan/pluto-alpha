#! /bin/bash

echo "Zipping up the code"
sls package --stage local

echo "Redeploying it"
awslocal lambda update-function-code --function-name 'add-savings' --zip-file fileb://.serverless/user-activity-api.zip
