FROM openjdk:8-jre-slim

WORKDIR /app

RUN apt-get update && apt-get install -y wget \
    && wget -O blazegraph.jar https://github.com/blazegraph/database/releases/download/BLAZEGRAPH_RELEASE_2_1_5/blazegraph.jar \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

EXPOSE 9999

CMD ["java", "-jar", "blazegraph.jar"]
