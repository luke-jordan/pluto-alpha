variable "admin_client_float_fetch_lambda_function_name" {
  default = "admin_client_float_fetch"
  type = string
}

resource "aws_lambda_function" "admin_client_float_fetch" {

  function_name                  = var.admin_client_float_fetch_lambda_function_name
  role                           = aws_iam_role.admin_client_float_fetch_role.arn
  handler                        = "admin-float-handler.fetchClientFloatDetails"
  memory_size                    = 256
  runtime                        = "nodejs12.x"
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
                "host": local.database_config.host,
                "database": local.database_config.database,
                "port": local.database_config.port
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

  depends_on = [aws_cloudwatch_log_group.admin_client_float_fetch]
}

resource "aws_iam_role" "admin_client_float_fetch_role" {
  name = "${var.admin_client_float_fetch_lambda_function_name}_role_${terraform.workspace}"

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

resource "aws_cloudwatch_log_group" "admin_client_float_fetch" {
  name = "/aws/lambda/${var.admin_client_float_fetch_lambda_function_name}"

  tags = {
    environment = terraform.workspace
  }
}

resource "aws_iam_role_policy_attachment" "admin_client_float_fetch_basic_execution_policy" {
  role = "${aws_iam_role.admin_client_float_fetch_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_client_float_fetch_vpc_execution_policy" {
  role = "${aws_iam_role.admin_client_float_fetch_role.name}"
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_iam_role_policy_attachment" "admin_client_float_fetch_secret_get" {
  role = "${aws_iam_role.admin_client_float_fetch_role.name}"
  policy_arn = "arn:aws:iam::455943420663:policy/${terraform.workspace}_secrets_admin_worker_read"
}

resource "aws_iam_role_policy_attachment" "admin_client_float_fetch_table_access" {
  role = "${aws_iam_role.admin_client_float_fetch_role.name}"
  policy_arn = "${aws_iam_policy.admin_client_float_access.arn}"
}

resource "aws_iam_role_policy_attachment" "admin_client_float_fetch_read_referral_codes" {
  role = aws_iam_role.admin_client_float_fetch_role.name
  policy_arn = aws_iam_policy.referral_code_read_policy.arn
}