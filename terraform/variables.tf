variable "max_app_count" {
  description = "Number of docker containers to run"
  default     = 4
}

variable "min_app_count" {
  description = "Number of docker containers to run"
  default     = 0
}

variable "aws_region" {
  description = "The AWS region to create things in."
  default     = "us-west-1"
}

variable "aws_account_id" {
  description = "AWS account ID"
  default     = ""
}

variable "az_count" {
  description = "Number of AZs to cover in a given AWS region"
  default     = "2"
}

variable "app_image" {
  description = "Docker image to run in the ECS cluster"
  default     = "adongy/hostname-docker:latest"
}

variable "app_port" {
  description = "Port exposed by the docker image to redirect traffic to"
  default     = 3000
}

variable "fargate_cpu" {
  description = "Fargate instance CPU units to provision (1 vCPU = 1024 CPU units)"
  default     = "256"
}

variable "fargate_memory" {
  description = "Fargate instance memory to provision (in MiB)"
  default     = "512"
}

variable "ecs_as_cpu_low_threshold_per" {
  default = "20"
}

variable "ecs_as_cpu_high_threshold_per" {
  default = "80"
}

variable "db_allocated_storage" {
  default = "10"
}

variable "db_name" {
  default = "main"
}

variable "db_instance_class" {
  default = "db.t2.micro"
}

variable "app_name" {
  default = "example"
}

variable "environment" {
  default = "dev"
}



