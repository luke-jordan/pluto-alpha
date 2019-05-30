variable "aws_access_key" {}
variable "aws_secret_key" {}
variable "aws_region" {
  description = "The AWS region to create things in."
  default     = "us-east-1"
}

variable "environment" {
  default = "dev"
}

variable "app_name" {
  default = "pluto-alpha"
}

variable "az_count" {
  description = "Number of AZs to cover in a given AWS region"
  default     = "2"
}

variable "db_name" {
  default = "main"
}

variable "db_instance_class" {
  default = "db.t2.micro"
}
variable "db_allocated_storage" {
  default = "10"
}

