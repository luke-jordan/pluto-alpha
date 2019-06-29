resource "aws_iam_policy" "dynamo_table_ClientFloatTable_access" {
  name        = "ClientFloatTable_access"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AccessClientFloatTable",
            "Effect": "Allow",
            "Action": [
                "dynamodb:*"
            ],
            "Resource": "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/ClientFloatTable"
        }
    ]
}
EOF
}