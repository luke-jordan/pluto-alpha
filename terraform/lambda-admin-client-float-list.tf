variable "admin_client_float_list_lambda_function_name" {
  default = "admin_client_float_list"
  type = "string"
}

resource "aws_lambda_function" "admin_client_float_list" {

  function_name                  = "${var.admin_client_float_list_lambda_function_name}"
  role                           = "${aws_iam_role.admin_client_float_list_role.arn}"
  handler                        = "index.fetchClientFloatVars"
  memory_size                    = 256
  runtime                        = "nodejs10.x"
  timeout                        = 15
  tags                           = {"environment"  = "${terraform.workspace}"}
  
  s3_bucket = "pluto.lambda.${terraform.workspace}"
  s3_key = "admin_api/${var.deploy_code_commit_hash}.zip"

  environment {
    variables = {
      DEBUG = "*"
      NODE_CONFIG = "${
        jsonencode(
          {
              "aws": {
                  "region": "${var.aws_default_region[terraform.workspace]}"
              },
              "db": {
                "host": "${aws_db_instance.rds[0].address}",
                "database": "${var.db_name}",
                "port" :"${aws_db_instance.rds[0].port}"
              },
              "secrets": {
                  "enabled": true,
                  "names": {
                      "admin_api_worker": "${terraform.workspace}/ops/psql/admin"
                  }
              }
          }
      )}"
    }
  }

  vpc_config {
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]
    security_group_ids = [aws_security_group.sg_5432_egress.id, aws_security_group.sg_db_access_sg.id, aws_security_group.sg_https_dns_egress.id]
  }

  depends_on = [aws_cloudwatch_log_group.admin_client_float_list]
}

resource "aws_iam_role" "admin_client_float_list_role" {
  name = "${var.admin_client_float_list_lambda_function_name}_role_${terraform.workspace}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_cloudwatch_log_group" "admin_client_float_list" {
  name = "/aws/lambda/${var.admin_client_float_list_lambda_function_name}"

  tags = {
    environment = "${terraform.workspace}"
  }
}

// putting this in here in case we move it out in future
resource "aws_iam_policy" "admin_client_float_access" {
  name = "lambda_admin_client_float_list_${terraform.workspace}"
  path = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "ClientFloatAdminAccess",
        "Effect": "Allow",
        "Action": [
          "dynamodb:Scan"
        ],
        "Resource": [
          "${aws_dynamodb_table.client-float-table.arn}",
          "${var.country_client_table_arn[terraform.workspace]}"
        ]
      }
    ]
}
EOF
}

resource "aws_iam_role_policy_attachment" "admin_client_float_list_basic_execution_policy" {
  role = "${aws_iam_role.admin_client_float_list_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_client_float_list_vpc_execution_policy" {
  role = "${aws_iam_role.admin_client_float_list_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_client_float_list_secret_get" {
  role = "${aws_iam_role.admin_client_float_list_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/secrets_read_admin_worker"
}

resource "aws_iam_role_policy_attachment" "admin_client_float_list_table_access" {
  role = "${aws_iam_role.admin_client_float_list_role.name}"
  policy_arn = "${aws_iam_policy.admin_client_float_access.arn}"
}
