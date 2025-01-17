#! /bin/bash

echo "Creating the DynamoDB table that holds the client floats"
awslocal cloudformation create-stack --template-body file://./templates/dynamodb/client-float-table.yml --stack-name client-float-table

echo "Adding in item for core, ZAR wholesale float"
awslocal dynamodb put-item --table-name ClientFloatTable --item file://./templates/dynamodb/zar_main_float_item.json