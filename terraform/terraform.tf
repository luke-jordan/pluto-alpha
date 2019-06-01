
provider "aws" {
  access_key = "${var.aws_access_key}"
  secret_key = "${var.aws_secret_access_key}"
  region     = "${var.aws_default_region[var.env]}"
}

terraform {
 backend "s3" {
 encrypt = true
 bucket = "pluto.terraform.state"
 dynamodb_table = "terraform-state-lock"
 region = "us-east-1"
 key = ".terraform/terraform.tfstate"
 }
}